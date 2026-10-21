// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AccountPage from "@/app/account/page";
import type { ApiMandate } from "@/lib/api";

/**
 * The account page shows when a subscriber's trial ends. The contract that
 * records it has not shipped, so the important case is the one where the
 * mandate carries no trial: the page must say nothing, rather than inferring a
 * trial from `next_charge` and telling a subscriber their free period ends on
 * a date that was never one.
 */

const wallet = vi.hoisted(() => ({
  address: null as string | null,
  connecting: false,
  error: null as string | null,
  networkMismatch: false,
  walletNetwork: null as string | null,
  connect: vi.fn(),
  disconnect: vi.fn(),
  signXdr: vi.fn(),
}));

const apiMock = vi.hoisted(() => ({
  isConfigured: vi.fn(() => true),
  mandatesOf: vi.fn(),
  vaultHistory: vi.fn(),
  stream: vi.fn(),
}));
const payflowMock = vi.hoisted(() => ({
  vaultBalance: vi.fn(),
  deposit: vi.fn(),
  withdraw: vi.fn(),
  depositFor: vi.fn(),
  setPaused: vi.fn(),
  cancel: vi.fn(),
}));
const chainMock = vi.hoisted(() => ({ chainMandatesOf: vi.fn() }));

vi.mock("@/lib/wallet", () => ({ useWallet: () => wallet }));

vi.mock("@/lib/api", () => ({
  api: {
    isConfigured: apiMock.isConfigured,
    mandatesOf: apiMock.mandatesOf,
    vaultHistory: apiMock.vaultHistory,
    stream: apiMock.stream,
  },
  checkWebhookUrl: vi.fn(),
}));
vi.mock("@/lib/payflow", () => ({
  payflow: payflowMock,
  // This page's tests predate payflow-contract#41; the dated pause stays off.
  mandatePauseUntil: () => null,
  // payflow-contract#34 not shipped; past-due stays off.
  mandateIsPastDue: () => false,
  mandatePastDueUntil: () => null,
  // payflow-contract#29 not shipped; the sponsor panel stays off.
  vaultSupportsDepositFor: async () => false,
  // payflow-contract#28 not shipped; the spend limit panel stays off.
  mandateSupportsSpendLimit: () => false,
}));
vi.mock("@/lib/chain", () => ({ chainMandatesOf: chainMock.chainMandatesOf }));

const SUBSCRIBER = "GAP6QFLXQD73URCC3EXU2WOQHIAREPCGMSIMKF5PFLLI5TR6HTMNDTIE";
const MERCHANT = "GCH5VHWNS24VI75HLDBHK4SSJ2E5XZA5IB6XEZTNE4BJH7AKZI6Z3MHU";
const DAY = 86_400;

function mandate(overrides: Partial<ApiMandate> = {}): ApiMandate {
  return {
    id: 7,
    subscriber: SUBSCRIBER,
    merchant: MERCHANT,
    plan_id: 1,
    amount: "10000000",
    period: 30 * DAY,
    next_charge: 0,
    last_charge: 0,
    charges_made: 0,
    max_charges: 0,
    fee_bps: 100,
    status: "Active",
    ended_by: null,
    ...overrides,
  };
}

beforeEach(() => {
  wallet.address = SUBSCRIBER;
  wallet.networkMismatch = false;
  payflowMock.vaultBalance.mockResolvedValue(0n);
  payflowMock.deposit.mockReset();
  payflowMock.withdraw.mockReset();
  payflowMock.setPaused.mockReset();
  payflowMock.cancel.mockReset();
  apiMock.mandatesOf.mockReset();
  apiMock.vaultHistory.mockReset();
  chainMock.chainMandatesOf.mockReset();
});

afterEach(cleanup);

describe("AccountPage free trials", () => {
  it("shows the trial end date while the trial is running", async () => {
    const ends = Math.floor(Date.now() / 1000) + 14 * DAY;
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ trial: 14 * DAY, next_charge: ends })],
    });

    render(<AccountPage />);

    expect(await screen.findByText("Mandate #7")).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Free trial ends");
    // Issue #45 spells relative times out; the exact date is beside it.
    expect(text).toContain("in 14 days");
    expect(text).toContain("Cancel before then and you pay nothing.");
  });

  it("says nothing at all when the source cannot report a trial", async () => {
    // The deployed contract and the current indexer both omit the field. Every
    // mandate's first charge is in the future, so inferring a trial from
    // next_charge would put a "Free trial" badge on every subscription.
    const future = Math.floor(Date.now() / 1000) + 30 * DAY;
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ next_charge: future })],
    });

    render(<AccountPage />);

    expect(await screen.findByText("Mandate #7")).toBeTruthy();
    expect(screen.queryByText("Free trial")).toBeNull();
    expect(document.body.textContent).not.toMatch(/free trial/i);
  });

  it("says nothing once the first charge has settled", async () => {
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ trial: 14 * DAY, charges_made: 1 })],
    });

    render(<AccountPage />);

    expect(await screen.findByText("Mandate #7")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/free trial/i);
  });

  it("drops the trial once the mandate is cancelled mid-trial", async () => {
    // Cancelling during a trial must never cost anything, so the page must not
    // keep advertising a running trial afterwards.
    const ends = Math.floor(Date.now() / 1000) + 3 * DAY;
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ trial: 3 * DAY, next_charge: ends, status: "Cancelled" })],
    });

    render(<AccountPage />);

    expect(await screen.findByText("Cancelled")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/free trial/i);
  });
});