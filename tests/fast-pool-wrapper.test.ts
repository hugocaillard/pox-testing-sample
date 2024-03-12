import {
  BooleanCV,
  Cl,
  ResponseOkCV,
  TupleCV,
  UIntCV,
  cvToString,
  PrincipalCV,
} from "@stacks/transactions";
import { describe, expect, it } from "vitest";
const accounts = simnet.getAccounts();
const address1 = accounts.get("wallet_1")!;

const contracts = {
  wrapper: "fast-pool-wrapper",
};

const prepareTest = () => {
  // whitelist address1
  const prepareResult = simnet.callPublicFn(
    contracts.wrapper,
    "set-whitelisted",
    [Cl.standardPrincipal(address1), Cl.bool(true)],
    simnet.deployer
  ).result;
  expect(prepareResult).toBeOk(Cl.bool(true));
};

describe("fast pool wrapper tests", () => {
  it("whitelisted user can delegate", () => {
    prepareTest();

    // delegate-stx on fast pool
    // this includes delegate-stack-stx and maybe aggregate commit
    const result = simnet.callPublicFn(
      contracts.wrapper,
      "delegate-stx",
      [Cl.uint(10_000_000e6)],
      address1
    ).result as ResponseOkCV<
      TupleCV<{
        "commit-result": BooleanCV;
        "lock-result": TupleCV<{
          "lock-amount": UIntCV;
          stacker: PrincipalCV;
          "unlock-burn-height": UIntCV;
        }>;
      }>
    >;
    expect(cvToString(result)).toBe(
      "(ok (tuple (commit-result true) (lock-result (tuple (lock-amount u9999999000000) (stacker ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.fast-pool-wrapper) (unlock-burn-height u4200)))))"
    );
    simnet.mineEmptyBlocks(1);

    // get stx-account for stacker
    const stxAccount = simnet.runSnippet(
      `(stx-account '${cvToString(
        result.value.data["lock-result"].data.stacker
      )})`
    ) as TupleCV<{ locked: UIntCV; "unlock-height": UIntCV; unlocked: UIntCV }>;

    expect(cvToString(stxAccount)).toBe(
      "(tuple (locked u0) (unlock-height u0) (unlocked u10000000000000))"
    );

    // verify result of stx-account and the delegation call
    expect(stxAccount.data.locked).toBe(
      result.value.data["lock-result"].data["lock-amount"]
    );
  });
});
