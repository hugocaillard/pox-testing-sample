import crypto from "node:crypto";
import {
  Cl,
  ClarityType,
  getAddressFromPrivateKey,
  TransactionVersion,
  createStacksPrivateKey,
  isClarityType,
} from "@stacks/transactions";
import { describe, expect, it, beforeEach, assert } from "vitest";
import { StacksDevnet } from "@stacks/network";
import {
  getPublicKeyFromPrivate,
  publicKeyToBtcAddress,
} from "@stacks/encryption";
import {
  Pox4SignatureTopic,
  StackingClient,
  poxAddressToTuple,
} from "@stacks/stacking";
import { Simnet } from "@hirosystems/clarinet-sdk";

const accounts = simnet.getAccounts();
const address1 = accounts.get("wallet_1")!;

const POX_DEPLOYER = "ST000000000000000000002AMW42H";
const POX_CONTRACT = `${POX_DEPLOYER}.pox-4`;

const initialSTXBalance = 100_000_000 * 1e6;

// const MAX_U128 = 340282366920938463463374607431768211455n;
const maxAmount = 20960000000000;
const randInt = () => crypto.randomInt(0, 0xffffffffffff);

// HELPERS
const getPoxInfo = (simnet: Simnet, poxContract: string) => {
  const poxInfo = simnet.callReadOnlyFn(
    poxContract,
    "get-pox-info",
    [],
    address1
  );
  // @ts-ignore
  const data = poxInfo.result.value.data;
  const typedPoxInfo = {
    firstBurnchainBlockHeight: data["first-burnchain-block-height"]
      .value as bigint,
    minAmountUstx: data["min-amount-ustx"].value as bigint,
    prepareCycleLength: data["prepare-cycle-length"].value as bigint,
    rewardCycleId: data["reward-cycle-id"].value as bigint,
    rewardCycleLength: data["reward-cycle-length"].value as bigint,
    totalLiquidSupplyUstx: data["total-liquid-supply-ustx"].value as bigint,
  };

  return typedPoxInfo;
};

const getTotalStacked = (
  simnet: Simnet,
  poxContract: string,
  cycleId: number | bigint
) => {
  const totalStacked = simnet.callReadOnlyFn(
    poxContract,
    "get-total-ustx-stacked",
    [Cl.uint(cycleId)],
    address1
  );
  // @ts-ignore
  return totalStacked.result.value as bigint;
};

// wallet_1, wallet_2, wallet_3 private keys
const stackingKeys = [
  "7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c17801",
  "530d9f61984c888536871c6573073bdfc0058896dc1adfe9a6a10dfacadc209101",
  "d655b2523bcd65e34889725c73064feb17ceb796831c0e111ba1a552b0f31b3901",
];

const stackers = stackingKeys.map((privKey, i) => {
  const network = new StacksDevnet();

  const pubKey = getPublicKeyFromPrivate(privKey);
  const stxAddress = getAddressFromPrivateKey(
    privKey,
    TransactionVersion.Testnet
  );
  const signerPrivKey = createStacksPrivateKey(privKey);
  const signerPubKey = getPublicKeyFromPrivate(signerPrivKey.data);

  return {
    authId: i,
    privKey,
    pubKey,
    stxAddress,
    btcAddr: publicKeyToBtcAddress(pubKey),
    signerPrivKey: signerPrivKey,
    signerPubKey: signerPubKey,
    client: new StackingClient(stxAddress, network),
  };
});

const stackingThreshold = 125000000000;

describe("pox-4", () => {
  beforeEach(async () => {
    simnet.setEpoch("3.0");
  });

  it("can call get-pox-info", async () => {
    const poxInfo = simnet.callReadOnlyFn(
      POX_CONTRACT,
      "get-pox-info",
      [],
      address1
    );
    assert(isClarityType(poxInfo.result, ClarityType.ResponseOk));
  });

  /*
    (stack-stx (amount-ustx uint)
      (pox-addr (tuple (version (buff 1)) (hashbytes (buff 32))))
      (start-burn-ht uint)
      (lock-period uint)
      (signer-sig (optional (buff 65)))
      (signer-key (buff 33))
      (max-amount uint)
      (auth-id uint))
  */

  describe("stack-stx", () => {
    it("can stack stxs", async () => {
      const account = stackers[0];
      const rewardCycle = 0;
      const burnBlockHeight = 1;
      const period = 10;
      const authId = randInt();

      const sigArgs = {
        authId,
        maxAmount,
        rewardCycle,
        period,
        topic: Pox4SignatureTopic.StackStx,
        poxAddress: account.btcAddr,
        signerPrivateKey: account.signerPrivKey,
      };
      const signerSignature = account.client.signPoxSignature(sigArgs);
      const signerKey = Cl.bufferFromHex(account.signerPubKey);
      const ustxAmount = Math.floor(stackingThreshold * 1.5);

      const stackStxArgs = [
        Cl.uint(ustxAmount),
        poxAddressToTuple(account.btcAddr),
        Cl.uint(burnBlockHeight),
        Cl.uint(period),
        Cl.some(Cl.bufferFromHex(signerSignature)),
        signerKey,
        Cl.uint(maxAmount),
        Cl.uint(authId),
      ];

      const stackStx = simnet.callPublicFn(
        POX_CONTRACT,
        "stack-stx",
        stackStxArgs,
        address1
      );

      expect(stackStx.result).toBeOk(
        Cl.tuple({
          "lock-amount": Cl.uint(187500000000),
          "signer-key": Cl.bufferFromHex(account.signerPubKey),
          stacker: Cl.principal(address1),
          "unlock-burn-height": Cl.uint(11550),
        })
      );

      const stxAccount = simnet.runSnippet(`(stx-account '${address1})`);
      expect(stxAccount).toBeTuple({
        locked: Cl.uint(ustxAmount),
        unlocked: Cl.uint(initialSTXBalance - ustxAmount),
        "unlock-height": Cl.uint(11550),
      });
    });

    it("can stack stxs from multiple accounts with the same key", () => {
      const signerAccount = stackers[0];
      const rewardCycle = 0;
      const burnBlockHeight = 0;
      const period = 10;

      const signerAccountKey = Cl.bufferFromHex(signerAccount.signerPubKey);

      let i = 0;
      for (const account of stackers) {
        const authId = i;
        i++;
        const sigArgs = {
          authId,
          maxAmount,
          rewardCycle,
          period,
          topic: Pox4SignatureTopic.StackStx,
          poxAddress: account.btcAddr,
          signerPrivateKey: signerAccount.signerPrivKey,
        };
        const signerSignature = signerAccount.client.signPoxSignature(sigArgs);
        const ustxAmount = Math.floor(stackingThreshold * 1.5);

        const stackStxArgs = [
          Cl.uint(ustxAmount),
          poxAddressToTuple(account.btcAddr),
          Cl.uint(burnBlockHeight),
          Cl.uint(period),
          Cl.some(Cl.bufferFromHex(signerSignature)),
          signerAccountKey,
          Cl.uint(maxAmount),
          Cl.uint(authId),
        ];

        const stackStx = simnet.callPublicFn(
          POX_CONTRACT,
          "stack-stx",
          stackStxArgs,
          account.stxAddress
        );

        expect(stackStx.result).toBeOk(
          Cl.tuple({
            "lock-amount": Cl.uint(187500000000),
            "signer-key": Cl.bufferFromHex(signerAccount.signerPubKey),
            stacker: Cl.principal(account.stxAddress),
            "unlock-burn-height": Cl.uint(11550),
          })
        );

        const stxAccount = simnet.runSnippet(
          `(stx-account '${account.stxAddress})`
        );
        expect(stxAccount).toBeTuple({
          locked: Cl.uint(ustxAmount),
          unlocked: Cl.uint(initialSTXBalance - ustxAmount),
          "unlock-height": Cl.uint(11550),
        });
      }
    });
  });

  describe("stack-extend", () => {
    it("can extend stacking during the last stacking cycle", () => {
      const poxInfo = getPoxInfo(simnet, POX_CONTRACT);
      const cycleLength = Number(poxInfo.rewardCycleLength);

      const account = stackers[0];
      const burnBlockHeight = 1;
      const authId = account.authId;

      const stackSignature = account.client.signPoxSignature({
        authId,
        maxAmount,
        rewardCycle: 0,
        period: 2,
        topic: Pox4SignatureTopic.StackStx,
        poxAddress: account.btcAddr,
        signerPrivateKey: account.signerPrivKey,
      });
      const signerKey = Cl.bufferFromHex(account.signerPubKey);
      const ustxAmount = Math.floor(stackingThreshold * 1.5);

      const stackStxArgs = [
        Cl.uint(ustxAmount),
        poxAddressToTuple(account.btcAddr),
        Cl.uint(burnBlockHeight),
        Cl.uint(2),
        Cl.some(Cl.bufferFromHex(stackSignature)),
        signerKey,
        Cl.uint(maxAmount),
        Cl.uint(authId),
      ];
      const stackStx = simnet.callPublicFn(
        POX_CONTRACT,
        "stack-stx",
        stackStxArgs,
        address1
      );
      expect(stackStx.result).toHaveClarityType(ClarityType.ResponseOk);

      // advance to cycle 1
      simnet.mineEmptyBlocks(cycleLength);

      // advance to cycle 2
      simnet.mineEmptyBlocks(cycleLength);
      // call stack-extend for 2 more cycles
      const extendSignature = account.client.signPoxSignature({
        authId,
        maxAmount,
        rewardCycle: 2,
        period: 2,
        topic: Pox4SignatureTopic.StackExtend,
        poxAddress: account.btcAddr,
        signerPrivateKey: account.signerPrivKey,
      });
      const extendArgs = [
        Cl.uint(2),
        poxAddressToTuple(account.btcAddr),
        Cl.some(Cl.bufferFromHex(extendSignature)),
        signerKey,
        Cl.uint(maxAmount),
        Cl.uint(authId),
      ];
      const { result } = simnet.callPublicFn(
        POX_CONTRACT,
        "stack-extend",
        extendArgs,
        address1
      );
      expect(result).toBeOk(
        Cl.tuple({
          stacker: Cl.principal(address1),
          "unlock-burn-height": Cl.uint(cycleLength * 5),
        })
      );

      // advance to cycle 3
      simnet.mineEmptyBlocks(cycleLength);
      const totalCycle3 = getTotalStacked(simnet, POX_CONTRACT, 3);
      expect(totalCycle3).toBe(BigInt(ustxAmount));

      // advance to cycle 4
      simnet.mineEmptyBlocks(cycleLength);
      const totalCycle4 = getTotalStacked(simnet, POX_CONTRACT, 4);
      expect(totalCycle4).toBe(BigInt(ustxAmount));

      // advance to cycle 5
      simnet.mineEmptyBlocks(cycleLength);
      const totalCycle5 = getTotalStacked(simnet, POX_CONTRACT, 5);
      expect(totalCycle5).toBe(0n);
    });

    it("can extend stacking during any stacking cycle", () => {
      const poxInfo = getPoxInfo(simnet, POX_CONTRACT);
      const cycleLength = Number(poxInfo.rewardCycleLength);

      const account = stackers[0];
      const burnBlockHeight = 1;
      const authId = account.authId;

      const stackSignature = account.client.signPoxSignature({
        authId,
        maxAmount,
        rewardCycle: 0,
        period: 2,
        topic: Pox4SignatureTopic.StackStx,
        poxAddress: account.btcAddr,
        signerPrivateKey: account.signerPrivKey,
      });
      const signerKey = Cl.bufferFromHex(account.signerPubKey);
      const ustxAmount = Math.floor(stackingThreshold * 1.5);

      const stackStxArgs = [
        Cl.uint(ustxAmount),
        poxAddressToTuple(account.btcAddr),
        Cl.uint(burnBlockHeight),
        Cl.uint(2),
        Cl.some(Cl.bufferFromHex(stackSignature)),
        signerKey,
        Cl.uint(maxAmount),
        Cl.uint(authId),
      ];
      const stackStx = simnet.callPublicFn(
        POX_CONTRACT,
        "stack-stx",
        stackStxArgs,
        address1
      );
      expect(stackStx.result).toHaveClarityType(ClarityType.ResponseOk);

      // advance to cycle 1
      simnet.mineEmptyBlocks(cycleLength);
      // call stack-extend for 2 more cycles
      const extendSignature = account.client.signPoxSignature({
        authId,
        maxAmount,
        rewardCycle: 1,
        period: 2,
        topic: Pox4SignatureTopic.StackExtend,
        poxAddress: account.btcAddr,
        signerPrivateKey: account.signerPrivKey,
      });
      const extendArgs = [
        Cl.uint(2),
        poxAddressToTuple(account.btcAddr),
        Cl.some(Cl.bufferFromHex(extendSignature)),
        signerKey,
        Cl.uint(maxAmount),
        Cl.uint(authId),
      ];
      const { result } = simnet.callPublicFn(
        POX_CONTRACT,
        "stack-extend",
        extendArgs,
        address1
      );
      expect(result).toBeOk(
        Cl.tuple({
          stacker: Cl.principal(address1),
          "unlock-burn-height": Cl.uint(cycleLength * 5),
        })
      );

      // advance to cycle 2
      simnet.mineEmptyBlocks(cycleLength);
      const totalCycle2 = getTotalStacked(simnet, POX_CONTRACT, 2);
      expect(totalCycle2).toBe(BigInt(ustxAmount));

      // advance to cycle 3
      simnet.mineEmptyBlocks(cycleLength);
      const totalCycle3 = getTotalStacked(simnet, POX_CONTRACT, 3);
      expect(totalCycle3).toBe(BigInt(ustxAmount));

      // advance to cycle 4
      simnet.mineEmptyBlocks(cycleLength);
      const totalCycle4 = getTotalStacked(simnet, POX_CONTRACT, 4);
      expect(totalCycle4).toBe(BigInt(ustxAmount));

      // advance to cycle 5
      simnet.mineEmptyBlocks(cycleLength);
      const totalCycle5 = getTotalStacked(simnet, POX_CONTRACT, 5);
      expect(totalCycle5).toBe(0n);
    });

    it("can not extend stacking after stacking end", () => {
      const poxInfo = getPoxInfo(simnet, POX_CONTRACT);
      const cycleLength = Number(poxInfo.rewardCycleLength);

      const account = stackers[0];
      const burnBlockHeight = 1;
      const authId = account.authId;

      const stackSignature = account.client.signPoxSignature({
        authId,
        maxAmount,
        rewardCycle: 0,
        period: 2,
        topic: Pox4SignatureTopic.StackStx,
        poxAddress: account.btcAddr,
        signerPrivateKey: account.signerPrivKey,
      });
      const signerKey = Cl.bufferFromHex(account.signerPubKey);
      const ustxAmount = Math.floor(stackingThreshold * 1.5);

      const stackStxArgs = [
        Cl.uint(ustxAmount),
        poxAddressToTuple(account.btcAddr),
        Cl.uint(burnBlockHeight),
        Cl.uint(2),
        Cl.some(Cl.bufferFromHex(stackSignature)),
        signerKey,
        Cl.uint(maxAmount),
        Cl.uint(authId),
      ];
      const stackStx = simnet.callPublicFn(
        POX_CONTRACT,
        "stack-stx",
        stackStxArgs,
        address1
      );
      expect(stackStx.result).toHaveClarityType(ClarityType.ResponseOk);

      // advance to cycle 3
      simnet.mineEmptyBlocks(cycleLength * 3);

      const extendSignature = account.client.signPoxSignature({
        authId,
        maxAmount,
        rewardCycle: 3,
        period: 2,
        topic: Pox4SignatureTopic.StackExtend,
        poxAddress: account.btcAddr,
        signerPrivateKey: account.signerPrivKey,
      });
      const extendArgs = [
        Cl.uint(2),
        poxAddressToTuple(account.btcAddr),
        Cl.some(Cl.bufferFromHex(extendSignature)),
        signerKey,
        Cl.uint(maxAmount),
        Cl.uint(authId),
      ];
      const { result } = simnet.callPublicFn(
        POX_CONTRACT,
        "stack-extend",
        extendArgs,
        address1
      );
      expect(result).toBeErr(Cl.int(26));
    });
  });
});
