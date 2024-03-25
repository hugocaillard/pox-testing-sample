import { Cl } from "@stacks/transactions";
import { describe, expect, it, beforeEach } from "vitest";
import { Simnet } from "@hirosystems/clarinet-sdk";

const accounts = simnet.getAccounts();
const address1 = accounts.get("wallet_1")!;
const address2 = accounts.get("wallet_2")!;

const POX_DEPLOYER = "ST000000000000000000002AMW42H";
const POX_CONTRACT = `${POX_DEPLOYER}.pox-3`;

const initialSTXBalance = 100_000_000 * 1e6;

// const MAX_U128 = 340282366920938463463374607431768211455n;

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
    currentRejectionVotes: data["current-rejection-votes"].value as bigint,
    firstBurnchainBlockHeight: data["first-burnchain-block-height"]
      .value as bigint,
    minAmountUstx: data["min-amount-ustx"].value as bigint,
    prepareCycleLength: data["prepare-cycle-length"].value as bigint,
    rejectionFraction: data["rejection-fraction"].value as bigint,
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

describe("pox-3", () => {
  beforeEach(async () => {
    simnet.setEpoch("2.4");
  });

  const ustxToLock = initialSTXBalance * 0.9; // lock 90% of the initial balance

  it("can transfer-stx", () => {
    // safe check that address1 can transfer 90% of its balance if not locked
    const transfer = simnet.transferSTX(ustxToLock, address2, address1);
    expect(transfer.result).toBeOk(Cl.bool(true));
  });

  it("can call is-pox-active", () => {
    const isPoxActive = simnet.callReadOnlyFn(
      POX_CONTRACT,
      "is-pox-active",
      [Cl.uint(100)],
      address1
    );
    expect(isPoxActive.result).toBeBool(true);
  });

  describe("stack-stx", () => {
    it("can stack stx", () => {
      const stackStxArgs = [
        Cl.uint(ustxToLock),
        Cl.tuple({
          version: Cl.bufferFromHex("00"),
          hashbytes: Cl.bufferFromHex(
            "7321b74e2b6a7e949e6c4ad313035b1665095017"
          ),
        }),
        Cl.uint(0),
        Cl.uint(2),
      ];
      const stackStx = simnet.callPublicFn(
        POX_CONTRACT,
        "stack-stx",
        stackStxArgs,
        address1
      );
      expect(stackStx.events).toHaveLength(2);
      expect(stackStx.result).toBeOk(
        Cl.tuple({
          "lock-amount": Cl.uint(ustxToLock),
          "unlock-burn-height": Cl.uint(3150),
          stacker: Cl.principal(address1),
        })
      );

      const stxAccount = simnet.runSnippet(`(stx-account '${address1})`);
      expect(stxAccount).toBeTuple({
        locked: Cl.uint(ustxToLock),
        unlocked: Cl.uint(initialSTXBalance - ustxToLock),
        "unlock-height": Cl.uint(3150),
      });

      const transfer = simnet.transferSTX(ustxToLock, address2, address1);
      expect(transfer.result).toBeErr(Cl.uint(1));

      const poxInfo0 = getPoxInfo(simnet, POX_CONTRACT);
      const totalCycle0 = getTotalStacked(
        simnet,
        POX_CONTRACT,
        poxInfo0.rewardCycleId
      );
      expect(totalCycle0).toBe(0n);

      const stackerInfo0 = simnet.callReadOnlyFn(
        POX_CONTRACT,
        "get-stacker-info",
        [Cl.principal(address1)],
        address1
      );
      expect(stackerInfo0.result).toBeSome(
        Cl.tuple({
          "delegated-to": Cl.none(),
          "first-reward-cycle": Cl.uint(1),
          "lock-period": Cl.uint(2),
          "pox-addr": stackStxArgs[1],
          "reward-set-indexes": Cl.list([Cl.uint(0), Cl.uint(0)]),
        })
      );
    });

    it("can unlock at the end of the duration", () => {
      const poxInfo = getPoxInfo(simnet, POX_CONTRACT);
      const cycleLength = Number(poxInfo.rewardCycleLength);
      expect(cycleLength).toBe(1050);

      // prepare by stacking for 2 cycles
      const stackStxArgs = [
        Cl.uint(ustxToLock),
        Cl.tuple({
          version: Cl.bufferFromHex("00"),
          hashbytes: Cl.bufferFromHex(
            "7321b74e2b6a7e949e6c4ad313035b1665095017"
          ),
        }),
        Cl.uint(0),
        Cl.uint(2),
      ];
      simnet.callPublicFn(POX_CONTRACT, "stack-stx", stackStxArgs, address1);

      // advance to cycle 1
      simnet.mineEmptyBlocks(cycleLength);
      const poxInfo1 = getPoxInfo(simnet, POX_CONTRACT);
      expect(poxInfo1.rewardCycleId).toBe(1n);
      const totalCycle1 = getTotalStacked(
        simnet,
        POX_CONTRACT,
        poxInfo1.rewardCycleId
      );
      expect(totalCycle1).toBe(BigInt(ustxToLock));

      // advance to cycle 2
      simnet.mineEmptyBlocks(cycleLength);
      const poxInfo2 = getPoxInfo(simnet, POX_CONTRACT);
      expect(poxInfo2.rewardCycleId).toBe(2n);
      const totalCycle2 = getTotalStacked(
        simnet,
        POX_CONTRACT,
        poxInfo2.rewardCycleId
      );
      expect(totalCycle2).toBe(BigInt(ustxToLock));
      const stackerInfo2 = simnet.callReadOnlyFn(
        POX_CONTRACT,
        "get-stacker-info",
        [Cl.principal(address1)],
        address1
      );
      expect(stackerInfo2.result).toBeSome(
        Cl.tuple({
          "delegated-to": Cl.none(),
          "first-reward-cycle": Cl.uint(1),
          "lock-period": Cl.uint(2),
          "pox-addr": stackStxArgs[1],
          "reward-set-indexes": Cl.list([Cl.uint(0), Cl.uint(0)]),
        })
      );

      // advance to cycle 3
      simnet.mineEmptyBlocks(cycleLength);
      const poxInfo3 = getPoxInfo(simnet, POX_CONTRACT);
      expect(poxInfo3.rewardCycleId).toBe(3n);
      const totalCycle3 = getTotalStacked(
        simnet,
        POX_CONTRACT,
        poxInfo3.rewardCycleId
      );
      expect(totalCycle3).toBe(0n);

      const stackerInfo3 = simnet.callReadOnlyFn(
        POX_CONTRACT,
        "get-stacker-info",
        [Cl.principal(address1)],
        address1
      );
      expect(stackerInfo3.result).toBeNone();
    });
  });

  describe("stack-extend", () => {
    it("can extend stacking during the last stacking cycle", () => {
      const poxInfo = getPoxInfo(simnet, POX_CONTRACT);
      const cycleLength = Number(poxInfo.rewardCycleLength);

      // prepare by stacking for 2 cycles
      const stackStxArgs = [
        Cl.uint(ustxToLock),
        Cl.tuple({
          version: Cl.bufferFromHex("00"),
          hashbytes: Cl.bufferFromHex(
            "7321b74e2b6a7e949e6c4ad313035b1665095017"
          ),
        }),
        Cl.uint(0),
        Cl.uint(2),
      ];
      simnet.callPublicFn(POX_CONTRACT, "stack-stx", stackStxArgs, address1);

      // advance to cycle 1
      simnet.mineEmptyBlocks(cycleLength);

      // advance to cycle 2
      simnet.mineEmptyBlocks(cycleLength);
      // call stack-extend for 2 more cycles
      const { result } = simnet.callPublicFn(
        POX_CONTRACT,
        "stack-extend",
        [
          Cl.uint(2),
          Cl.tuple({
            version: Cl.bufferFromHex("00"),
            hashbytes: Cl.bufferFromHex(
              "7321b74e2b6a7e949e6c4ad313035b1665095017"
            ),
          }),
        ],
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
      expect(totalCycle3).toBe(BigInt(ustxToLock));

      // advance to cycle 4
      simnet.mineEmptyBlocks(cycleLength);
      const totalCycle4 = getTotalStacked(simnet, POX_CONTRACT, 4);
      expect(totalCycle4).toBe(BigInt(ustxToLock));

      // advance to cycle 5
      simnet.mineEmptyBlocks(cycleLength);
      const totalCycle5 = getTotalStacked(simnet, POX_CONTRACT, 5);
      expect(totalCycle5).toBe(0n);
    });

    it("can extend stacking during any stacking cycle", () => {
      const poxInfo = getPoxInfo(simnet, POX_CONTRACT);
      const cycleLength = Number(
        poxInfo.prepareCycleLength + poxInfo.rewardCycleLength
      );

      // prepare by stacking for 2 cycles
      const stackStxArgs = [
        Cl.uint(ustxToLock),
        Cl.tuple({
          version: Cl.bufferFromHex("00"),
          hashbytes: Cl.bufferFromHex(
            "7321b74e2b6a7e949e6c4ad313035b1665095017"
          ),
        }),
        Cl.uint(0),
        Cl.uint(2),
      ];
      simnet.callPublicFn(POX_CONTRACT, "stack-stx", stackStxArgs, address1);

      // advance to cycle 1
      simnet.mineEmptyBlocks(cycleLength);
      // call stack-extend for 2 more cycles
      const { result } = simnet.callPublicFn(
        POX_CONTRACT,
        "stack-extend",
        [
          Cl.uint(2),
          Cl.tuple({
            version: Cl.bufferFromHex("00"),
            hashbytes: Cl.bufferFromHex(
              "7321b74e2b6a7e949e6c4ad313035b1665095017"
            ),
          }),
        ],
        address1
      );
      expect(result).toBeOk(
        Cl.tuple({
          stacker: Cl.principal(address1),
          "unlock-burn-height": Cl.uint(5250),
        })
      );

      // advance to cycle 2
      simnet.mineEmptyBlocks(cycleLength);
      const totalCycle2 = getTotalStacked(simnet, POX_CONTRACT, 2);
      expect(totalCycle2).toBe(BigInt(ustxToLock));

      // advance to cycle 3
      simnet.mineEmptyBlocks(cycleLength);
      const totalCycle3 = getTotalStacked(simnet, POX_CONTRACT, 3);
      expect(totalCycle3).toBe(BigInt(ustxToLock));

      // advance to cycle 4
      simnet.mineEmptyBlocks(cycleLength);
      const totalCycle4 = getTotalStacked(simnet, POX_CONTRACT, 4);
      expect(totalCycle4).toBe(BigInt(ustxToLock));

      // advance to cycle 5
      simnet.mineEmptyBlocks(cycleLength);
      const totalCycle5 = getTotalStacked(simnet, POX_CONTRACT, 5);
      expect(totalCycle5).toBe(0n);
    });

    it("can not extend stacking after stacking end", () => {
      const poxInfo = getPoxInfo(simnet, POX_CONTRACT);
      const cycleLength = Number(
        poxInfo.prepareCycleLength + poxInfo.rewardCycleLength
      );

      // prepare by stacking for 2 cycles
      const stackStxArgs = [
        Cl.uint(ustxToLock),
        Cl.tuple({
          version: Cl.bufferFromHex("00"),
          hashbytes: Cl.bufferFromHex(
            "7321b74e2b6a7e949e6c4ad313035b1665095017"
          ),
        }),
        Cl.uint(0),
        Cl.uint(2),
      ];
      simnet.callPublicFn(POX_CONTRACT, "stack-stx", stackStxArgs, address1);

      // advance to cycle 3
      simnet.mineEmptyBlocks(cycleLength * 3);

      const totalCycle3 = getTotalStacked(simnet, POX_CONTRACT, 3);
      expect(totalCycle3).toBe(0n);
      const { result } = simnet.callPublicFn(
        POX_CONTRACT,
        "stack-extend",
        [
          Cl.uint(2),
          Cl.tuple({
            version: Cl.bufferFromHex("00"),
            hashbytes: Cl.bufferFromHex(
              "7321b74e2b6a7e949e6c4ad313035b1665095017"
            ),
          }),
        ],
        address1
      );
      expect(result).toBeErr(Cl.int(26));
    });
  });
});
