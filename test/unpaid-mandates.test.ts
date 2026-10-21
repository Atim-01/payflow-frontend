import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { chainUnpaidMandates, type UnpaidMandate } from "@/lib/chain";
import { payflow } from "@/lib/payflow";
import type { ApiMandate } from "@/lib/api";

/**
 * Tests for the unpaid mandates feature (issue #170).
 *
 * Unpaid mandates are active subscriptions where the subscriber's vault
 * cannot cover the next charge. The merchant dashboard shows these in a
 * dedicated tab so merchants know who needs to top up their vault.
 */

const MERCHANT = "GCH5VHWNS24VI75HLDBHK4SSJ2E5XZA5IB6XEZTNE4BJH7AKZI6Z3MHU";
const SUBSCRIBER_A = "GAP6QFLXQD73URCC3EXU2WOQHIAREPCGMSIMKF5PFLLI5TR6HTMNDTIE";
const SUBSCRIBER_B = "GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function mandate(over: Partial<ApiMandate> = {}): ApiMandate {
  return {
    id: 1,
    subscriber: SUBSCRIBER_A,
    merchant: MERCHANT,
    plan_id: 1,
    amount: "10000000", // 1 XLM in stroops
    period: 2_592_000,
    next_charge: Math.floor(Date.now() / 1000) - 3600, // Due 1 hour ago
    last_charge: 0,
    charges_made: 0,
    max_charges: 0,
    fee_bps: 100,
    status: "Active",
    token: TOKEN,
    ...over,
  };
}

describe("chainUnpaidMandates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty array when all mandates are funded", async () => {
    const now = Math.floor(Date.now() / 1000);
    const mandates = [mandate({ id: 1, next_charge: now - 100 })];

    // Mock chainMandatesFor to return our test mandates
    vi.spyOn(await import("@/lib/chain"), "chainMandatesFor").mockResolvedValue(mandates);

    // Mock vaultBalance to show sufficient funds
    vi.spyOn(payflow, "vaultBalance").mockResolvedValue(20_000_000n); // 2 XLM

    const unpaid = await chainUnpaidMandates("test-source", MERCHANT, now);
    expect(unpaid).toEqual([]);
  });

  it("identifies mandates with insufficient vault balance", async () => {
    const now = Math.floor(Date.now() / 1000);
    const mandates = [
      mandate({ id: 1, amount: "10000000", next_charge: now - 100 }),
    ];

    vi.spyOn(await import("@/lib/chain"), "chainMandatesFor").mockResolvedValue(mandates);

    // Mock vaultBalance to show insufficient funds (0.5 XLM when 1 XLM needed)
    vi.spyOn(payflow, "vaultBalance").mockResolvedValue(5_000_000n);

    const unpaid = await chainUnpaidMandates("test-source", MERCHANT, now);

    expect(unpaid).toHaveLength(1);
    expect(unpaid[0]).toMatchObject({
      mandate: expect.objectContaining({ id: 1 }),
      shortfall: 5_000_000n,
      overdueDuration: 100,
    });
  });

  it("excludes mandates not yet due", async () => {
    const now = Math.floor(Date.now() / 1000);
    const mandates = [
      mandate({ id: 1, next_charge: now + 3600 }), // Due in 1 hour
    ];

    vi.spyOn(await import("@/lib/chain"), "chainMandatesFor").mockResolvedValue(mandates);
    vi.spyOn(payflow, "vaultBalance").mockResolvedValue(0n); // Zero balance

    const unpaid = await chainUnpaidMandates("test-source", MERCHANT, now);
    expect(unpaid).toEqual([]);
  });

  it("excludes paused mandates even if underfunded", async () => {
    const now = Math.floor(Date.now() / 1000);
    const mandates = [
      mandate({ id: 1, status: "Paused", next_charge: now - 100 }),
    ];

    vi.spyOn(await import("@/lib/chain"), "chainMandatesFor").mockResolvedValue(mandates);
    vi.spyOn(payflow, "vaultBalance").mockResolvedValue(0n);

    const unpaid = await chainUnpaidMandates("test-source", MERCHANT, now);
    expect(unpaid).toEqual([]);
  });

  it("excludes cancelled mandates", async () => {
    const now = Math.floor(Date.now() / 1000);
    const mandates = [
      mandate({ id: 1, status: "Cancelled", next_charge: now - 100 }),
    ];

    vi.spyOn(await import("@/lib/chain"), "chainMandatesFor").mockResolvedValue(mandates);
    vi.spyOn(payflow, "vaultBalance").mockResolvedValue(0n);

    const unpaid = await chainUnpaidMandates("test-source", MERCHANT, now);
    expect(unpaid).toEqual([]);
  });

  it("sorts unpaid mandates by most overdue first", async () => {
    const now = Math.floor(Date.now() / 1000);
    const mandates = [
      mandate({ id: 1, subscriber: SUBSCRIBER_A, next_charge: now - 100 }), // 100s overdue
      mandate({ id: 2, subscriber: SUBSCRIBER_B, next_charge: now - 500 }), // 500s overdue
      mandate({ id: 3, subscriber: SUBSCRIBER_A, next_charge: now - 300 }), // 300s overdue
    ];

    vi.spyOn(await import("@/lib/chain"), "chainMandatesFor").mockResolvedValue(mandates);

    // All have insufficient balance
    vi.spyOn(payflow, "vaultBalance").mockResolvedValue(0n);

    const unpaid = await chainUnpaidMandates("test-source", MERCHANT, now);

    expect(unpaid).toHaveLength(3);
    // Should be sorted: id 2 (500s), id 3 (300s), id 1 (100s)
    expect(unpaid[0]?.mandate.id).toBe(2);
    expect(unpaid[1]?.mandate.id).toBe(3);
    expect(unpaid[2]?.mandate.id).toBe(1);
  });

  it("calculates correct shortfall amounts", async () => {
    const now = Math.floor(Date.now() / 1000);
    const mandates = [
      mandate({ id: 1, amount: "10000000", next_charge: now - 100 }), // Needs 1 XLM
      mandate({ id: 2, amount: "50000000", next_charge: now - 100 }), // Needs 5 XLM
    ];

    vi.spyOn(await import("@/lib/chain"), "chainMandatesFor").mockResolvedValue(mandates);

    // First subscriber has 0.3 XLM, second has 2 XLM
    vi.spyOn(payflow, "vaultBalance")
      .mockImplementation(async (source, subscriber) => {
        if (subscriber === SUBSCRIBER_A) return 3_000_000n;
        return 20_000_000n;
      });

    const unpaid = await chainUnpaidMandates("test-source", MERCHANT, now);

    expect(unpaid).toHaveLength(2);
    
    const mandate1 = unpaid.find(u => u.mandate.id === 1);
    const mandate2 = unpaid.find(u => u.mandate.id === 2);

    expect(mandate1?.shortfall).toBe(7_000_000n); // Needs 10M, has 3M = short 7M
    expect(mandate2?.shortfall).toBe(30_000_000n); // Needs 50M, has 20M = short 30M
  });

  it("handles vault balance read failures gracefully", async () => {
    const now = Math.floor(Date.now() / 1000);
    const mandates = [
      mandate({ id: 1, next_charge: now - 100 }),
      mandate({ id: 2, next_charge: now - 100 }),
    ];

    vi.spyOn(await import("@/lib/chain"), "chainMandatesFor").mockResolvedValue(mandates);

    // First succeeds with shortfall, second fails
    vi.spyOn(payflow, "vaultBalance")
      .mockResolvedValueOnce(0n)
      .mockRejectedValueOnce(new Error("RPC failure"));

    const unpaid = await chainUnpaidMandates("test-source", MERCHANT, now);

    // Should only include the mandate where vault read succeeded
    expect(unpaid).toHaveLength(1);
    expect(unpaid[0]?.mandate.id).toBe(1);
  });

  it("calculates overdue duration correctly", async () => {
    const now = Math.floor(Date.now() / 1000);
    const oneHourAgo = now - 3600;
    const oneDayAgo = now - 86400;

    const mandates = [
      mandate({ id: 1, next_charge: oneHourAgo }),
      mandate({ id: 2, next_charge: oneDayAgo }),
    ];

    vi.spyOn(await import("@/lib/chain"), "chainMandatesFor").mockResolvedValue(mandates);
    vi.spyOn(payflow, "vaultBalance").mockResolvedValue(0n);

    const unpaid = await chainUnpaidMandates("test-source", MERCHANT, now);

    expect(unpaid).toHaveLength(2);
    
    const mandate1 = unpaid.find(u => u.mandate.id === 1);
    const mandate2 = unpaid.find(u => u.mandate.id === 2);

    expect(mandate1?.overdueDuration).toBe(3600);
    expect(mandate2?.overdueDuration).toBe(86400);
  });

  it("handles empty mandate list", async () => {
    const now = Math.floor(Date.now() / 1000);

    vi.spyOn(await import("@/lib/chain"), "chainMandatesFor").mockResolvedValue([]);

    const unpaid = await chainUnpaidMandates("test-source", MERCHANT, now);
    expect(unpaid).toEqual([]);
  });

  it("handles exactly zero balance as underfunded", async () => {
    const now = Math.floor(Date.now() / 1000);
    const mandates = [mandate({ id: 1, amount: "10000000", next_charge: now - 100 })];

    vi.spyOn(await import("@/lib/chain"), "chainMandatesFor").mockResolvedValue(mandates);
    vi.spyOn(payflow, "vaultBalance").mockResolvedValue(0n);

    const unpaid = await chainUnpaidMandates("test-source", MERCHANT, now);

    expect(unpaid).toHaveLength(1);
    expect(unpaid[0]?.shortfall).toBe(10_000_000n);
  });

  it("handles exactly sufficient balance as funded", async () => {
    const now = Math.floor(Date.now() / 1000);
    const mandates = [mandate({ id: 1, amount: "10000000", next_charge: now - 100 })];

    vi.spyOn(await import("@/lib/chain"), "chainMandatesFor").mockResolvedValue(mandates);
    vi.spyOn(payflow, "vaultBalance").mockResolvedValue(10_000_000n); // Exactly enough

    const unpaid = await chainUnpaidMandates("test-source", MERCHANT, now);
    expect(unpaid).toEqual([]);
  });
});
