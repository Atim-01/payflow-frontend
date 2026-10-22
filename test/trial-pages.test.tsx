// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import SubscribePage from "@/app/subscribe/page";
import MerchantPage from "@/app/merchant/page";
import type { ApiPlan } from "@/lib/api";

/**
 * Free trials depend on payflow-contract#9, which has not shipped, so both
 * pages have to behave sensibly against a source with no `trial` field at all.
 * The merchant form is the sharper edge: passing the trial argument to the
 * deployed five-argument `create_plan` would fail every publish, so the control
 * must not appear until the source proves it can carry the field.
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
  plans: vi.fn(),
  mandatesFor: vi.fn(),
  merchantSummary: vi.fn(),
  merchantRevenue: vi.fn(),
  merchantChurn: vi.fn(),
  merchantCohortRetention: vi.fn(),
  planStats: vi.fn(),
  stream: vi.fn(),
  webhooks: vi.fn(),
  addWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  testWebhook: vi.fn(),
}));
const payflowMock = vi.hoisted(() => ({
  feeBps: vi.fn(),
  createPlan: vi.fn(),
  subscribe: vi.fn(),
  setPlanActive: vi.fn(),
  charge: vi.fn(),
  endMandate: vi.fn(),
}));
const chainMock = vi.hoisted(() => ({
  chainPlans: vi.fn(),
  chainMandatesFor: vi.fn(),
  chainMerchantSummary: vi.fn(),
  chainPlansOf: vi.fn(),
  chainPlanSubscriberCount: vi.fn(),
  endable: vi.fn(() => false),
}));

vi.mock("@/lib/wallet", () => ({ useWallet: () => wallet }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { api: apiMock, checkWebhookUrl: actual.checkWebhookUrl };
});
vi.mock("@/lib/payflow", () => ({
  payflow: payflowMock,
  MAX_NAME_LEN: 64,
  nameByteLength: (n: string) => n.length,
}));
vi.mock("@/lib/chain", () => chainMock);

const MERCHANT = "GCH5VHWNS24VI75HLDBHK4SSJ2E5XZA5IB6XEZTNE4BJH7AKZI6Z3MHU";
const SUBSCRIBER = "GAP6QFLXQD73URCC3EXU2WOQHIAREPCGMSIMKF5PFLLI5TR6HTMNDTIE";
const DAY = 86_400;

function plan(over: Partial<ApiPlan> = {}): ApiPlan {
  return {
    id: 1,
    merchant: MERCHANT,
    name: "Pro Monthly",
    token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    amount: "10000000",
    period: 30 * DAY,
    active: 1,
    ledger: 0,
    ...over,
  };
}

beforeEach(() => {
  wallet.address = SUBSCRIBER;
  wallet.networkMismatch = false;
  apiMock.isConfigured.mockReturnValue(true);
  payflowMock.feeBps.mockResolvedValue(100);
  payflowMock.createPlan.mockResolvedValue("tx-hash");
  apiMock.merchantSummary.mockResolvedValue(null);
  apiMock.merchantRevenue.mockResolvedValue(null);
  apiMock.merchantChurn.mockResolvedValue(null);
  apiMock.merchantCohortRetention.mockResolvedValue(null);
  apiMock.mandatesFor.mockResolvedValue({ mandates: [] });
  apiMock.planStats.mockResolvedValue(null);
  apiMock.webhooks.mockResolvedValue([]);
  chainMock.chainPlanSubscriberCount.mockResolvedValue(null);
  chainMock.chainMerchantSummary.mockReturnValue({
    merchant: MERCHANT,
    activeMandates: 0,
    totalCollected: null,
    chargeCount: 0,
    mrr: "0",
  });
});

afterEach(cleanup);

describe("SubscribePage free-trial badges", () => {
  it("badges a plan that has a trial and says what it means", async () => {
    apiMock.plans.mockResolvedValue({ plans: [plan({ trial: 14 * DAY })] });

    render(<SubscribePage />);

    expect(await screen.findByText("14-day free trial")).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Nothing is charged for 14 days");
    expect(text).toContain("cancel any time before the first charge");
  });

  it("renders no badge for a plan without one", async () => {
    // The acceptance criterion, and the case every deployment is in today:
    // the deployed contract has no `trial` field at all.
    apiMock.plans.mockResolvedValue({
      plans: [plan(), plan({ id: 2, name: "Starter", trial: 0 })],
    });

    render(<SubscribePage />);

    expect(await screen.findByText("Pro Monthly")).toBeTruthy();
    expect(screen.getByText("Starter")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/free trial/i);
  });

  it("still lists and badges plans read straight from the contract", async () => {
    // Contract-only mode: no indexer, so the plans come from get_plan. They
    // simply carry no trial until payflow-contract#9 ships.
    apiMock.plans.mockResolvedValue(null);
    chainMock.chainPlans.mockResolvedValue([plan({ trial: 7 * DAY })]);

    render(<SubscribePage />);

    expect(await screen.findByText("7-day free trial")).toBeTruthy();
    expect(chainMock.chainPlans).toHaveBeenCalled();
  });

  it("tells the subscriber when their trial ends after they subscribe", async () => {
    // `subscribe` does not return the mandate id, so the confirmation is the
    // only place the trial length can be turned into a date at signing time.
    apiMock.plans.mockResolvedValue({ plans: [plan({ trial: 14 * DAY })] });
    payflowMock.subscribe.mockResolvedValue("a".repeat(64));

    render(<SubscribePage />);
    const button = await screen.findByRole("button", { name: "Subscribe" });
    button.click();

    await vi.waitFor(() => expect(payflowMock.subscribe).toHaveBeenCalled());
    const notice = await screen.findByText(/Subscribed\./);
    expect(notice.parentElement?.textContent).toContain("14-day free trial");
    expect(notice.parentElement?.textContent).toMatch(/first charge is due 14 days from now/);
  });

  it("says nothing about a trial in the confirmation when there was none", async () => {
    apiMock.plans.mockResolvedValue({ plans: [plan()] });
    payflowMock.subscribe.mockResolvedValue("a".repeat(64));

    render(<SubscribePage />);
    (await screen.findByRole("button", { name: "Subscribe" })).click();

    const notice = await screen.findByText(/Subscribed\./);
    expect(notice.parentElement?.textContent).not.toMatch(/free trial/i);
  });
});

describe("MerchantPage trial control", () => {
  it("is hidden while the source cannot report a trial", async () => {
    // The deployed contract's create_plan takes five arguments. Offering the
    // control here would let a merchant pick a trial and have every publish
    // fail on-chain.
    wallet.address = MERCHANT;
    apiMock.plans.mockResolvedValue({ plans: [plan({ merchant: MERCHANT })] });

    render(<MerchantPage />);

    expect(await screen.findByText("Publish a plan")).toBeTruthy();
    expect(screen.queryByLabelText(/free trial/i)).toBeNull();
  });

  it("appears once a plan proves the contract carries the field", async () => {
    wallet.address = MERCHANT;
    apiMock.plans.mockResolvedValue({
      plans: [plan({ merchant: MERCHANT, trial: 0 })],
    });

    render(<MerchantPage />);

    expect(await screen.findByLabelText(/free trial/i)).toBeTruthy();
    expect(screen.getByRole("option", { name: "None" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "14 days" })).toBeTruthy();
  });
});