import { Cl } from "@stacks/transactions";
import { describe, expect, it, beforeEach } from "vitest";

const accounts = simnet.getAccounts();
const address1 = accounts.get("wallet_1")!;
const address2 = accounts.get("wallet_2")!;

const poxDeployer = "ST000000000000000000002AMW42H";

const initialSTXBalance = 100_000_000 * 1e6;

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
