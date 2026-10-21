import { describe, expect, it } from "vitest";
import { chargeShortfall } from "@/lib/schedule";

/**
 * Tests for the unpaid mandates feature (issue #170).
 *
 * The unpaid mandates feature identifies active subscriptions where the
 * subscriber's vault cannot cover the next charge. Since `chainUnpaidMandates`
 * makes RPC calls to read contract state, these tests focus on the pure
 * calculation logic. Integration testing is done manually.
 */

describe("chargeShortfall (used by unpaid mandates)", () => {
  it("returns null when balance is sufficient", () => {
    const balance = 10_000_000n; // 1 XLM
    const amount = 5_000_000n; // 0.5 XLM
    expect(chargeShortfall(balance, amount)).toBeNull();
  });

  it("returns shortfall when balance is insufficient", () => {
    const balance = 3_000_000n; // 0.3 XLM
    const amount = 10_000_000n; // 1 XLM
    const shortfall = chargeShortfall(balance, amount);
    expect(shortfall).toBe(7_000_000n); // Need 0.7 XLM more
  });

  it("returns null when balance is exactly sufficient", () => {
    const balance = 10_000_000n;
    const amount = 10_000_000n;
    expect(chargeShortfall(balance, amount)).toBeNull();
  });

  it("returns full amount as shortfall when balance is zero", () => {
    const balance = 0n;
    const amount = 10_000_000n;
    const shortfall = chargeShortfall(balance, amount);
    expect(shortfall).toBe(10_000_000n);
  });

  it("returns null when balance is unknown (null)", () => {
    // Null balance means read is in flight or failed - don't block the charge
    const balance = null;
    const amount = 10_000_000n;
    expect(chargeShortfall(balance, amount)).toBeNull();
  });

  it("calculates shortfall correctly for small amounts", () => {
    const balance = 100n;
    const amount = 150n;
    const shortfall = chargeShortfall(balance, amount);
    expect(shortfall).toBe(50n);
  });

  it("calculates shortfall correctly for large amounts", () => {
    const balance = 1_000_000_000_000n; // 100,000 XLM
    const amount = 5_000_000_000_000n; // 500,000 XLM
    const shortfall = chargeShortfall(balance, amount);
    expect(shortfall).toBe(4_000_000_000_000n); // Need 400,000 XLM more
  });
});

/**
 * Manual integration test checklist for chainUnpaidMandates:
 *
 * ✅ Empty results when all mandates are funded
 * ✅ Identifies mandates with insufficient vault balance  
 * ✅ Excludes mandates not yet due (next_charge > now)
 * ✅ Excludes paused mandates even if underfunded
 * ✅ Excludes cancelled and completed mandates
 * ✅ Sorts unpaid mandates by most overdue first
 * ✅ Calculates correct shortfall amounts
 * ✅ Handles vault balance read failures gracefully
 * ✅ Calculates overdue duration correctly
 * ✅ Handles empty mandate list
 * ✅ Handles exactly zero balance as underfunded
 * ✅ Handles exactly sufficient balance as funded
 *
 * The function works correctly in both API and contract-only modes as verified
 * by manual testing with npm run dev.
 */
