import { expect } from "chai";
import { Contract, BigNumber } from "ethers";
import { ethers, waffle } from "hardhat";

import {
  ORDER_TYPE_HASH,
  OrderKind,
  SettlementEncoder,
  SigningScheme,
  computeOrderUid,
  extractOrderUidParams,
  hashOrder,
} from "../src/ts";

import { decodeTrade } from "./encoding";

function fillBytes(count: number, byte: number): string {
  return ethers.utils.hexlify([...Array(count)].map(() => byte));
}

function fillDistinctBytes(count: number, start: number): string {
  return ethers.utils.hexlify(
    [...Array(count)].map((_, i) => (start + i) % 256),
  );
}

function fillUint(bits: number, byte: number): BigNumber {
  return BigNumber.from(fillBytes(bits / 8, byte));
}

describe("GPv2Encoding", () => {
  const [, ...traders] = waffle.provider.getWallets();

  const testDomain = { name: "test" };
  const sampleOrder = {
    sellToken: fillBytes(20, 0x01),
    buyToken: fillBytes(20, 0x02),
    sellAmount: ethers.utils.parseEther("42"),
    buyAmount: ethers.utils.parseEther("13.37"),
    validTo: 0xffffffff,
    appData: 0,
    feeAmount: ethers.utils.parseEther("1.0"),
    kind: OrderKind.SELL,
    partiallyFillable: false,
  };

  let encoding: Contract;

  beforeEach(async () => {
    const GPv2Encoding = await ethers.getContractFactory(
      "GPv2EncodingTestInterface",
    );

    encoding = await GPv2Encoding.deploy();
  });

  describe("DOMAIN_SEPARATOR", () => {
    it("should match the test domain hash", async () => {
      expect(await encoding.DOMAIN_SEPARATOR()).to.equal(
        ethers.utils._TypedDataEncoder.hashDomain(testDomain),
      );
    });
  });

  describe("ORDER_TYPE_HASH", () => {
    it("should be match the EIP-712 order type hash", async () => {
      expect(await encoding.orderTypeHashTest()).to.equal(ORDER_TYPE_HASH);
    });
  });

  describe("tradeCount", () => {
    it("should compute the number of encoded trades", async () => {
      const tradeCount = 10;
      const encoder = new SettlementEncoder(testDomain);
      for (let i = 0; i < tradeCount; i++) {
        await encoder.signEncodeTrade(
          { ...sampleOrder, appData: i },
          traders[0],
          SigningScheme.TYPED_DATA,
        );
      }

      expect(encoder.tradeCount).to.equal(tradeCount);
      expect(await encoding.tradeCountTest(encoder.encodedTrades)).to.equal(
        tradeCount,
      );
    });

    it("should revert if trade bytes are too short.", async () => {
      await expect(encoding.tradeCountTest("0x1337")).to.be.revertedWith(
        "malformed trade data",
      );
    });

    it("should revert if trade bytes are too long.", async () => {
      await expect(
        encoding.tradeCountTest(
          ethers.utils.hexlify([...Array(205)].map(() => 42)),
        ),
      ).to.be.revertedWith("malformed trade data");
    });
  });

  describe("decodeTrade", () => {
    it("should round-trip encode order data", async () => {
      // NOTE: Pay extra attention to use all bytes for each field, and that
      // they all have different values to make sure the are correctly
      // round-tripped.
      const order = {
        sellToken: fillBytes(20, 0x01),
        buyToken: fillBytes(20, 0x02),
        sellAmount: fillUint(256, 0x03),
        buyAmount: fillUint(256, 0x04),
        validTo: fillUint(32, 0x05).toNumber(),
        appData: fillUint(32, 0x06).toNumber(),
        feeAmount: fillUint(256, 0x07),
        kind: OrderKind.BUY,
        partiallyFillable: true,
      };
      const tradeExecution = {
        executedAmount: fillUint(256, 0x08),
        feeDiscount: fillUint(16, 0x09).toNumber(),
      };

      const encoder = new SettlementEncoder(testDomain);
      await encoder.signEncodeTrade(
        order,
        traders[0],
        SigningScheme.TYPED_DATA,
        tradeExecution,
      );

      const [decodedTrades] = await encoding.decodeTradesTest(
        encoder.tokens,
        encoder.encodedTrades,
      );

      // NOTE: Ethers.js returns a tuple and not a struct with named fields for
      // `abicoder v2` structs.
      expect(decodedTrades.length).to.equal(1);

      const { order: decodedOrder, executedAmount, feeDiscount } = decodeTrade(
        decodedTrades[0],
      );
      expect(decodedOrder).to.deep.equal(order);
      expect({ executedAmount, feeDiscount }).to.deep.equal(tradeExecution);
    });

    it("should return order token indices", async () => {
      const encoder = new SettlementEncoder(testDomain);
      await encoder.signEncodeTrade(
        sampleOrder,
        traders[0],
        SigningScheme.TYPED_DATA,
      );

      const [decodedTrades] = await encoding.decodeTradesTest(
        encoder.tokens,
        encoder.encodedTrades,
      );
      const { sellTokenIndex, buyTokenIndex } = decodeTrade(decodedTrades[0]);
      expect(sellTokenIndex).to.equal(
        encoder.tokens.indexOf(sampleOrder.sellToken),
      );
      expect(buyTokenIndex).to.equal(
        encoder.tokens.indexOf(sampleOrder.buyToken),
      );
    });

    it("should compute EIP-712 order struct hash", async () => {
      const encoder = new SettlementEncoder(testDomain);
      await encoder.signEncodeTrade(
        sampleOrder,
        traders[0],
        SigningScheme.TYPED_DATA,
      );

      const [decodedTrades] = await encoding.decodeTradesTest(
        encoder.tokens,
        encoder.encodedTrades,
      );

      const { orderDigest } = extractOrderUidParams(
        decodeTrade(decodedTrades[0]).orderUid,
      );
      expect(orderDigest).to.equal(hashOrder(sampleOrder));
    });

    it("should compute order unique identifier", async () => {
      const encoder = new SettlementEncoder(testDomain);
      await encoder.signEncodeTrade(
        sampleOrder,
        traders[0],
        SigningScheme.TYPED_DATA,
      );

      const [decodedTrades] = await encoding.decodeTradesTest(
        encoder.tokens,
        encoder.encodedTrades,
      );

      const { orderUid } = decodeTrade(decodedTrades[0]);
      expect(orderUid).to.equal(
        computeOrderUid({
          orderDigest: hashOrder(sampleOrder),
          owner: traders[0].address,
          validTo: sampleOrder.validTo,
        }),
      );
    });

    it("should recover signing address for all supported schemes", async () => {
      const encoder = new SettlementEncoder(testDomain);
      for (const scheme of [SigningScheme.TYPED_DATA, SigningScheme.MESSAGE]) {
        await encoder.signEncodeTrade(sampleOrder, traders[0], scheme);
      }

      const [decodedTrades] = await encoding.decodeTradesTest(
        encoder.tokens,
        encoder.encodedTrades,
      );

      const traderAddress = await traders[0].getAddress();
      for (const decodedTrade of decodedTrades) {
        const { owner } = decodeTrade(decodedTrade);
        expect(owner).to.equal(traderAddress);
      }
    });

    it("should revert for invalid order signatures", async () => {
      const encoder = new SettlementEncoder(testDomain);
      await encoder.signEncodeTrade(
        sampleOrder,
        traders[0],
        SigningScheme.TYPED_DATA,
      );

      // NOTE: `v` must be either `27` or `28`, so just set it to something else
      // to generate an invalid signature.
      const encodedTradeBytes = ethers.utils.arrayify(encoder.encodedTrades);
      encodedTradeBytes[141] = 42;

      await expect(
        encoding.decodeTradesTest(encoder.tokens, encodedTradeBytes),
      ).to.be.revertedWith("invalid signature");
    });

    it("should revert for invalid sell token indices", async () => {
      const lastToken = fillBytes(20, 0x03);

      const encoder = new SettlementEncoder(testDomain);
      await encoder.signEncodeTrade(
        sampleOrder,
        traders[0],
        SigningScheme.TYPED_DATA,
      );
      await encoder.signEncodeTrade(
        {
          ...sampleOrder,
          sellToken: lastToken,
        },
        traders[1],
        SigningScheme.TYPED_DATA,
      );

      // NOTE: Remove the last sell token (0x0303...0303).
      const tokens = encoder.tokens;
      expect(tokens.pop()).to.equal(lastToken);
      await expect(encoding.decodeTradesTest(tokens, encoder.encodedTrades)).to
        .be.reverted;
    });

    it("should revert for invalid sell token indices", async () => {
      const lastToken = fillBytes(20, 0x03);

      const encoder = new SettlementEncoder(testDomain);
      await encoder.signEncodeTrade(
        sampleOrder,
        traders[0],
        SigningScheme.TYPED_DATA,
      );
      await encoder.signEncodeTrade(
        {
          ...sampleOrder,
          buyToken: lastToken,
        },
        traders[1],
        SigningScheme.TYPED_DATA,
      );

      // NOTE: Remove the last buy token (0x0303...0303).
      const tokens = encoder.tokens;
      expect(tokens.pop()).to.equal(lastToken);
      await expect(encoding.decodeTradesTest(tokens, encoder.encodedTrades)).to
        .be.reverted;
    });

    it("should not allocate additional memory", async () => {
      // NOTE: We want to make sure that calls to `decodeOrder` does not require
      // additional memory allocations to save on memory per orders.
      const encoder = new SettlementEncoder(testDomain);
      await encoder.signEncodeTrade(
        sampleOrder,
        traders[0],
        SigningScheme.TYPED_DATA,
      );
      await encoder.signEncodeTrade(
        sampleOrder,
        traders[1],
        SigningScheme.MESSAGE,
      );

      const [, mem] = await encoding.decodeTradesTest(
        encoder.tokens,
        encoder.encodedTrades,
      );
      expect(mem.toNumber()).to.equal(0);
    });
  });

  describe("decodeInteraction", () => {
    it("decodes sample encoded interaction", async () => {
      // Example from the documentation describing `decodeInteraction` in the
      // [`GPv2Encoding`] library.
      const encodedInteraction =
        "0x73c14081446bd1e4eb165250e826e80c5a523783000010000102030405060708090a0b0c0d0e0f";
      const callData = "0x000102030405060708090a0b0c0d0e0f";
      const target = ethers.utils.getAddress(
        "0x73c14081446bd1e4eb165250e826e80c5a523783",
      );

      // Note: the number of interactions is a convenience input used to
      // preallocate the memory needed to store all interactions simultaneously.
      // If this number does not correspond exactly to the amount recovered
      // after decoding, then the test call reverts.
      const numInteractions = 1;
      const interactions = await encoding.decodeInteractionsTest(
        encodedInteraction,
        numInteractions,
      );

      expect(interactions.length).to.equal(1);
      expect(interactions[0].target).to.equal(target);
      expect(interactions[0].callData).to.equal(callData);
    });

    it("should round-trip encode a single interaction", async () => {
      // Note: all fields should use distinct bytes to make decoding errors
      // easier to spot. 0x11 is used to avoid having bytes with zeroes in their
      // hex representation.
      const interaction = {
        target: ethers.utils.getAddress(fillDistinctBytes(20, 0x11)),
        callData: fillDistinctBytes(42, 0x11 + 20),
      };

      const encoder = new SettlementEncoder(testDomain);
      await encoder.encodeInteraction(interaction);

      const numInteractions = 1;
      const decodedInteractions = await encoding.decodeInteractionsTest(
        encoder.encodedInteractions,
        numInteractions,
      );

      expect(decodedInteractions.length).to.equal(1);
      expect(decodedInteractions[0].target).to.equal(interaction.target);
      expect(decodedInteractions[0].callData).to.equal(interaction.callData);
    });

    it("should round-trip encode multiple interactions", async () => {
      // Note: all fields should use distinct bytes as much as possible to make
      // decoding errors easier to spot. 0x11 is used to avoid having bytes with
      // zeroes in their hex representation.
      const interaction1 = {
        target: ethers.utils.getAddress(fillDistinctBytes(20, 0x11)),
        callData: fillDistinctBytes(42, 0x11 + 20),
      };
      const interaction2 = {
        target: ethers.utils.getAddress(fillDistinctBytes(20, 0x11 + 20 + 42)),
        callData: fillDistinctBytes(1337, 0x11 + 2 * 20 + 42),
      };
      const interaction3 = {
        target: ethers.utils.getAddress(
          fillDistinctBytes(20, 0x11 + 2 * 20 + 42 + 1337),
        ),
        // Note: if the interaction decoding becomes significantly more
        // inefficient, this test might fail with "tx has a higher gas limit
        // than the block". In this case, the number of bytes below should be
        // reduced.
        callData: fillDistinctBytes(12000, 0x11 + 3 * 20 + 42 + 1337),
      };

      const encoder = new SettlementEncoder(testDomain);
      await encoder.encodeInteraction(interaction1);
      await encoder.encodeInteraction(interaction2);
      await encoder.encodeInteraction(interaction3);

      const numInteractions = 3;
      const decodedInteractions = await encoding.decodeInteractionsTest(
        encoder.encodedInteractions,
        numInteractions,
      );

      expect(decodedInteractions.length).to.equal(3);
      expect(decodedInteractions[0].target).to.equal(interaction1.target);
      expect(decodedInteractions[0].callData).to.equal(interaction1.callData);
      expect(decodedInteractions[1].target).to.equal(interaction2.target);
      expect(decodedInteractions[1].callData).to.equal(interaction2.callData);
      expect(decodedInteractions[2].target).to.equal(interaction3.target);
      expect(decodedInteractions[2].callData).to.equal(interaction3.callData);
    });

    // Skipped because this test takes a surprisingly long time to complete.
    // It is supposed to be passing without any change.
    it.skip("encoder fails to add interactions with too much calldata", async () => {
      const interaction = {
        target: ethers.utils.getAddress(fillBytes(20, 0x00)),
        callData: fillDistinctBytes(2 ** (8 * 3), 0x00),
      };

      const encoder = new SettlementEncoder(testDomain);
      expect(() => encoder.encodeInteraction(interaction)).to.throw;
    });

    it("should round-trip encode an empty interaction", async () => {
      const interaction = {
        target: ethers.utils.getAddress(
          "0x73c14081446bd1e4eb165250e826e80c5a523783",
        ),
        callData: "0x",
      };

      const encoder = new SettlementEncoder(testDomain);
      await encoder.encodeInteraction(interaction);

      const numInteractions = 1;
      const decodedInteractions = await encoding.decodeInteractionsTest(
        encoder.encodedInteractions,
        numInteractions,
      );

      expect(decodedInteractions.length).to.equal(1);
      expect(decodedInteractions[0].target).to.equal(interaction.target);
      expect(decodedInteractions[0].callData).to.equal(interaction.callData);
    });

    describe("invalid encoded interaction", () => {
      it("calldata shorter than length", async () => {
        const interaction = {
          target: ethers.utils.getAddress(fillBytes(20, 0x00)),
          callData: fillDistinctBytes(10, 0x00),
        };

        const encoder = new SettlementEncoder(testDomain);
        await encoder.encodeInteraction(interaction);

        const numInteractions = 1;
        const decoding = encoding.decodeInteractionsTest(
          encoder.encodedInteractions.slice(0, -2),
          numInteractions,
        );

        await expect(decoding).to.be.revertedWith("GPv2: invalid interaction");
      });

      it("calldata longer than length", async () => {
        const interaction = {
          target: ethers.utils.getAddress(fillBytes(20, 0x00)),
          callData: fillDistinctBytes(10, 0x00),
        };

        const encoder = new SettlementEncoder(testDomain);
        await encoder.encodeInteraction(interaction);

        const numInteractions = 1;
        const decoding = encoding.decodeInteractionsTest(
          encoder.encodedInteractions + "00",
          numInteractions,
        );

        // Note: this call does not revert with "GPv2: invalid interaction", as
        // it would appear intuitive, but with "invalid opcode". This is because
        // of how `decodeInteractionsTest` works: since there is some calldata
        // left, it tries to parse it as another interaction. But the array used
        // to store the decoded interactions has size 1, so the function is
        // accessing an out-of-bound element.
        await expect(decoding).to.be.reverted;
      });
    });
  });

  describe("extractOrderUidParams", () => {
    it("round trip encode/decode", async () => {
      // Start from 17 (0x11) so that the first byte has no zeroes.
      const orderDigest = fillDistinctBytes(32, 17);
      const address = ethers.utils.getAddress(fillDistinctBytes(20, 17 + 32));
      const validTo = BigNumber.from(fillDistinctBytes(4, 17 + 32 + 20));

      const orderUid = computeOrderUid({
        orderDigest,
        owner: address,
        validTo: validTo.toNumber(),
      });
      expect(orderUid).to.equal(fillDistinctBytes(32 + 20 + 4, 17));

      const {
        orderDigest: extractedOrderDigest,
        owner: extractedAddress,
        validTo: extractedValidTo,
      } = await encoding.extractOrderUidParamsTest(orderUid);
      expect(extractedOrderDigest).to.equal(orderDigest);
      expect(extractedValidTo).to.equal(validTo);
      expect(extractedAddress).to.equal(address);
    });

    describe("fails on uid", () => {
      const uidStride = 32 + 20 + 4;

      it("longer than expected", async () => {
        const invalidUid = "0x" + "00".repeat(uidStride + 1);

        await expect(
          encoding.extractOrderUidParamsTest(invalidUid),
        ).to.be.revertedWith("GPv2: invalid uid");
      });

      it("shorter than expected", async () => {
        const invalidUid = "0x" + "00".repeat(uidStride - 1);

        await expect(
          encoding.extractOrderUidParamsTest(invalidUid),
        ).to.be.revertedWith("GPv2: invalid uid");
      });
    });
  });
});
