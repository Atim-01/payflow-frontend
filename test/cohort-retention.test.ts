import { describe, expect, it } from "vitest";
import {
  formatRetentionPercent,
  parseCohortRetention,
  retentionColorClass,
} from "@/lib/cohort-retention";

const MERCHANT = "GABC";

function cohort(
  month: string,
  size: number,
  retention: number[],
) {
  return { cohort: month, size, retention };
}

function response(cohorts: ReturnType<typeof cohort>[]) {
  return { merchant: MERCHANT, cohorts };
}

describe("parseCohortRetention", () => {
  it("parses cohort retention data with multiple months", () => {
    const body = response([
      cohort("2026-10", 12, [100, 91.7, 83.3, 75.0]),
      cohort("2026-11", 8, [100, 87.5, 75.0]),
    ]);

    const result = parseCohortRetention(body, MERCHANT);
    expect(result).toEqual({
      merchant: MERCHANT,
      cohorts: [
        { cohort: "2026-10", size: 12, retention: [100, 91.7, 83.3, 75.0] },
        { cohort: "2026-11", size: 8, retention: [100, 87.5, 75.0] },
      ],
      maxAge: 3,
    });
  });

  it("orders cohorts chronologically", () => {
    const body = response([
      cohort("2026-11", 5, [100, 80.0]),
      cohort("2026-09", 10, [100, 90.0, 80.0, 70.0]),
      cohort("2026-10", 8, [100, 87.5, 75.0]),
    ]);

    const result = parseCohortRetention(body, MERCHANT);
    expect(result?.cohorts.map((c) => c.cohort)).toEqual(["2026-09", "2026-10", "2026-11"]);
  });

  it("calculates maxAge from the longest retention array", () => {
    const body = response([
      cohort("2026-09", 10, [100, 90.0, 80.0, 70.0, 60.0]),
      cohort("2026-10", 8, [100, 87.5]),
      cohort("2026-11", 5, [100]),
    ]);

    const result = parseCohortRetention(body, MERCHANT);
    expect(result?.maxAge).toBe(4);
  });

  it("accepts empty cohort list", () => {
    const body = response([]);
    const result = parseCohortRetention(body, MERCHANT);
    expect(result).toEqual({
      merchant: MERCHANT,
      cohorts: [],
      maxAge: 0,
    });
  });

  it("accepts zero-sized cohorts", () => {
    const body = response([cohort("2026-10", 0, [100])]);
    const result = parseCohortRetention(body, MERCHANT);
    expect(result?.cohorts[0]?.size).toBe(0);
  });

  it("rejects month 0 retention not equal to 100%", () => {
    const body = response([cohort("2026-10", 10, [99, 90, 80])]);
    expect(parseCohortRetention(body, MERCHANT)).toBeNull();
  });

  it("rejects retention percentages outside [0, 100]", () => {
    expect(
      parseCohortRetention(
        response([cohort("2026-10", 10, [100, 101])]),
        MERCHANT,
      ),
    ).toBeNull();
    expect(
      parseCohortRetention(
        response([cohort("2026-10", 10, [100, -5])]),
        MERCHANT,
      ),
    ).toBeNull();
  });

  it("rejects invalid month formats", () => {
    expect(
      parseCohortRetention(
        response([cohort("2026-13", 10, [100])]),
        MERCHANT,
      ),
    ).toBeNull();
    expect(
      parseCohortRetention(
        response([cohort("2026-00", 10, [100])]),
        MERCHANT,
      ),
    ).toBeNull();
    expect(
      parseCohortRetention(
        response([cohort("26-10", 10, [100])]),
        MERCHANT,
      ),
    ).toBeNull();
  });

  it("rejects duplicate cohort months", () => {
    const body = response([
      cohort("2026-10", 10, [100, 90]),
      cohort("2026-10", 5, [100, 80]),
    ]);
    expect(parseCohortRetention(body, MERCHANT)).toBeNull();
  });

  it("rejects negative cohort sizes", () => {
    const body = response([cohort("2026-10", -1, [100])]);
    expect(parseCohortRetention(body, MERCHANT)).toBeNull();
  });

  it("rejects non-integer cohort sizes", () => {
    const body = response([cohort("2026-10", 10.5, [100])]);
    expect(parseCohortRetention(body, MERCHANT)).toBeNull();
  });

  it.each([
    null,
    {},
    { merchant: MERCHANT },
    { merchant: "GOTHER", cohorts: [] },
    { merchant: MERCHANT, cohorts: "not an array" },
    { merchant: MERCHANT, cohorts: [{ cohort: "2026-10", size: 10 }] }, // missing retention
    { merchant: MERCHANT, cohorts: [{ cohort: "2026-10", retention: [100] }] }, // missing size
  ])("rejects malformed or incomplete backend response %#", (body) => {
    expect(parseCohortRetention(body, MERCHANT)).toBeNull();
  });
});

describe("formatRetentionPercent", () => {
  it("formats whole percentages without decimals", () => {
    expect(formatRetentionPercent(100)).toBe("100%");
    expect(formatRetentionPercent(75)).toBe("75%");
    expect(formatRetentionPercent(0)).toBe("0%");
  });

  it("formats fractional percentages with up to 1 decimal place", () => {
    expect(formatRetentionPercent(91.7)).toBe("91.7%");
    expect(formatRetentionPercent(83.3)).toBe("83.3%");
    expect(formatRetentionPercent(66.6)).toBe("66.6%");
  });

  it("removes trailing zeros from decimals", () => {
    expect(formatRetentionPercent(90.0)).toBe("90%");
    expect(formatRetentionPercent(50.0)).toBe("50%");
  });
});

describe("retentionColorClass", () => {
  it("returns green for high retention (90%+)", () => {
    expect(retentionColorClass(100)).toBe("bg-green-100 dark:bg-green-950");
    expect(retentionColorClass(90)).toBe("bg-green-100 dark:bg-green-950");
  });

  it("returns lighter green for good retention (70-89%)", () => {
    expect(retentionColorClass(89)).toBe("bg-green-50 dark:bg-green-900/50");
    expect(retentionColorClass(70)).toBe("bg-green-50 dark:bg-green-900/50");
  });

  it("returns yellow for moderate retention (50-69%)", () => {
    expect(retentionColorClass(69)).toBe("bg-yellow-50 dark:bg-yellow-900/50");
    expect(retentionColorClass(50)).toBe("bg-yellow-50 dark:bg-yellow-900/50");
  });

  it("returns orange for low retention (30-49%)", () => {
    expect(retentionColorClass(49)).toBe("bg-orange-50 dark:bg-orange-900/50");
    expect(retentionColorClass(30)).toBe("bg-orange-50 dark:bg-orange-900/50");
  });

  it("returns red for very low retention (1-29%)", () => {
    expect(retentionColorClass(29)).toBe("bg-red-50 dark:bg-red-900/50");
    expect(retentionColorClass(1)).toBe("bg-red-50 dark:bg-red-900/50");
  });

  it("returns gray for zero retention", () => {
    expect(retentionColorClass(0)).toBe("bg-gray-50 dark:bg-gray-900/50");
  });
});
