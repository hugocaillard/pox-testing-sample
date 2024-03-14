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

const accounts = simnet.getAccounts();
const address1 = accounts.get("wallet_1")!;
const address2 = accounts.get("wallet_2")!;

const poxDeployer = "ST000000000000000000002AMW42H";

const initialSTXBalance = 100_000_000 * 1e6;

const MAX_U128 = 340282366920938463463374607431768211455n;
const maxAmount = MAX_U128;
const randInt = () => crypto.randomInt(0, 0xffffffffffff);

describe("test pox-3", () => {
  beforeEach(async () => {
    simnet.setEpoch("2.4");
  });

  const poxContract = `${poxDeployer}.pox-3`;

  const ustxToLock = initialSTXBalance * 0.9; // lock 90% of the initial balance

  it("can transfer-stx", () => {
    // safe check that address1 can transfer 90% of its balance if not locked
    const transfer = simnet.transferSTX(ustxToLock, address2, address1);
    expect(transfer.result).toBeOk(Cl.bool(true));
  });

  it("can call is-pox-active", () => {
    const isPoxActive = simnet.callReadOnlyFn(
      poxContract,
      "is-pox-active",
      [Cl.uint(100)],
      address1
    );
    expect(isPoxActive.result).toBeBool(true);
  });

  it("can stack stx on pox-3", () => {
    const stackStxArgs = [
      Cl.uint(ustxToLock),
      Cl.tuple({
        version: Cl.bufferFromHex("00"),
        hashbytes: Cl.bufferFromHex("7321b74e2b6a7e949e6c4ad313035b1665095017"),
      }),
      Cl.uint(0),
      Cl.uint(1),
    ];
    const stackStx = simnet.callPublicFn(
      poxContract,
      "stack-stx",
      stackStxArgs,
      address1
    );
    expect(stackStx.events).toHaveLength(2);
    expect(stackStx.result).toBeOk(
      Cl.tuple({
        "lock-amount": Cl.uint(ustxToLock),
        "unlock-burn-height": Cl.uint(2100),
        stacker: Cl.principal(address1),
      })
    );

    const stxAccount = simnet.runSnippet(`(stx-account '${address1})`);
    expect(stxAccount).toBeTuple({
      locked: Cl.uint(ustxToLock),
      unlocked: Cl.uint(initialSTXBalance - ustxToLock),
      "unlock-height": Cl.uint(2100),
    });

    const transfer = simnet.transferSTX(ustxToLock, address2, address1);
    expect(transfer.result).toBeErr(Cl.uint(1));
  });
});

describe("test pox-4", () => {
  const poxContract = `${poxDeployer}.pox-4`;

  // wallet_1, wallet_2, wallet_3 private keys
  const stackingKeys = [
    "7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c17801",
    "530d9f61984c888536871c6573073bdfc0058896dc1adfe9a6a10dfacadc209101",
    "d655b2523bcd65e34889725c73064feb17ceb796831c0e111ba1a552b0f31b3901",
  ];

  const accounts = stackingKeys.map((privKey) => {
    const network = new StacksDevnet();

    const pubKey = getPublicKeyFromPrivate(privKey);
    const stxAddress = getAddressFromPrivateKey(
      privKey,
      TransactionVersion.Testnet
    );
    const signerPrivKey = createStacksPrivateKey(privKey);
    const signerPubKey = getPublicKeyFromPrivate(signerPrivKey.data);

    return {
      privKey,
      pubKey,
      stxAddress,
      btcAddr: publicKeyToBtcAddress(pubKey),
      signerPrivKey: signerPrivKey,
      signerPubKey: signerPubKey,
      client: new StackingClient(stxAddress, {
        ...network,
        transactionVersion: network.version,
        magicBytes: "X2",
        peerNetworkId: network.chainId,
      }),
    };
  });

  const stackingThreshold = 125000000000;

  beforeEach(async () => {
    simnet.setEpoch("3.0");
  });

  it("can call get-pox-info", async () => {
    const poxInfo = simnet.callReadOnlyFn(
      poxContract,
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

  it("can stack stxs", async () => {
    const account = accounts[0];
    const rewardCycle = 0;
    const burnBlockHeight = 0;
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
      poxContract,
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
    const signerAccount = accounts[0];
    const rewardCycle = 0;
    const burnBlockHeight = 0;
    const period = 10;

    const signerAccountKey = Cl.bufferFromHex(signerAccount.signerPubKey);

    for (const account of accounts) {
      const authId = randInt();
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
        poxContract,
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
