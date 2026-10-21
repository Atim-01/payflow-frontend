// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AccountPage from "@/app/account/page";
import type { ApiMandate } from "@/lib/api";

/**
 * The subscriber's side of a merchant discount (issue #115): the discounted
 * price and how many discounted charges are left.
 *
 * The subscriber must never be told about a discount that does not exist, so
 * a mandate without the fields shows the full price and nothing else.
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
  readContract: vi.fn(),
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
  readContract: payflowMock.readContract,
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
vi.mock("@/lib/toml", () => ({ useOrgName: () => null }));

const SUBSCRIBER = "GAP6QFLXQD73URCC3EXU2WOQHIAREPCGMSIMKF5PFLLI5TR6HTMNDTIE";
const MERCHANT = "GCH5VHWNS24VI75HLDBHK4SSJ2E5XZA5IB6XEZTNE4BJH7AKZI6Z3MHU";

function mandate(overrides: Partial<ApiMandate> = {}): ApiMandate {
  return {
    id: 7,
    subscriber: SUBSCRIBER,
    merchant: MERCHANT,
    plan_id: 1,
    amount: "10000000", // 1 XLM
    period: 2_592_000,
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

beforeEach(async () => {
  wallet.address = SUBSCRIBER;
  wallet.networkMismatch = false;
  apiMock.mandatesOf.mockReset();
  apiMock.vaultHistory.mockReset();
  payflowMock.vaultBalance.mockReset();
  payflowMock.deposit.mockReset();
  payflowMock.withdraw.mockReset();
  payflowMock.setPaused.mockReset();
  payflowMock.cancel.mockReset();
  payflowMock.readContract.mockReset();
  chainMock.chainMandatesOf.mockReset();
  payflowMock.vaultBalance.mockResolvedValue(50_000_000n);
  apiMock.vaultHistory.mockResolvedValue(null);
  const { clearTokenMetaCache } = await import("@/lib/token");
  clearTokenMetaCache();
});

afterEach(cleanup);

describe("AccountPage discount", () => {
  it("shows the discounted price and the charges that are left", async () => {
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [
        mandate({ discount_bps: 2000, discount_charges: 3, discount_charges_made: 1 }),
      ],
    });

    render(<AccountPage />);

    // 1 XLM at 20% off is 0.8 XLM.
    expect(await screen.findByText("0.8 XLM")).toBeTruthy();
    expect(screen.getByText("20% off for 3 charges")).toBeTruthy();
    expect(screen.getByText(/2 discounted charges left/)).toBeTruthy();
  });

  it("shows the full price once the discount has run out", async () => {
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [
        mandate({ discount_bps: 2000, discount_charges: 3, discount_charges_made: 3 }),
      ],
    });

    render(<AccountPage />);

    expect(await screen.findByText(/1 XLM per month/)).toBeTruthy();
    expect(screen.getByText(/the discount has run out/i)).toBeTruthy();
  });

  it("says nothing about a discount when there is none", async () => {
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate()] });

    render(<AccountPage />);

    expect(await screen.findByText(/1 XLM per month/)).toBeTruthy();
    expect(screen.queryByText(/off for/i)).toBeNull();
    expect(screen.queryByText(/discount/i)).toBeNull();
  });

  it("does not claim a price it cannot know", async () => {
    // A contract that carries the rate but not the count of the charges
    // already made: the price of the next charge is unknown.
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ discount_bps: 2000, discount_charges: 3 })],
    });

    render(<AccountPage />);

    expect(await screen.findByText("20% off for 3 charges")).toBeTruthy();
    expect(screen.getByText(/the merchant set a discount/i)).toBeTruthy();
    expect(screen.queryByText(/0.8 XLM/)).toBeNull();
  });
});
