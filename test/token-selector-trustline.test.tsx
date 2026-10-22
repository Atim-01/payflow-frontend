// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import MerchantPage from "@/app/merchant/page";
import AccountPage from "@/app/account/page";
import type { ApiMandate } from "@/lib/api";

const USDC_SAC_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SUBSCRIBER = "GAP6QFLXQD73URCC3EXU2WOQHIAREPCGMSIMKF5PFLLI5TR6HTMNDTIE";
const MERCHANT = "GCH5VHWNS24VI75HLDBHK4SSJ2E5XZA5IB6XEZTNE4BJH7AKZI6Z3MHU";

const wallet = vi.hoisted(() => ({
  address: "GCH5VHWNS24VI75HLDBHK4SSJ2E5XZA5IB6XEZTNE4BJH7AKZI6Z3MHU" as string | null,
  connecting: false,
  error: null as string | null,
  networkMismatch: false,
  walletNetwork: null as string | null,
  connect: vi.fn(),
  disconnect: vi.fn(),
  signXdr: vi.fn(async () => "AAAA...signed"),
}));

const apiMock = vi.hoisted(() => ({
  isConfigured: vi.fn(() => true),
  plans: vi.fn(),
  mandatesFor: vi.fn(),
  mandatesOf: vi.fn(),
  vaultHistory: vi.fn(),
  merchantSummary: vi.fn(),
  merchantRevenue: vi.fn(async () => ({ points: [] })),
  merchantChurn: vi.fn(async () => ({ months: [] })),
  merchantCohortRetention: vi.fn(async () => null),
  planStats: vi.fn(),
  stream: vi.fn(() => null),
  webhooks: vi.fn(async () => []),
  addWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  testWebhook: vi.fn(),
}));

const payflowMock = vi.hoisted(() => ({
  createPlan: vi.fn(async () => "tx-create-plan"),
  setPlanActive: vi.fn(),
  vaultBalance: vi.fn(async () => 100_000_000n),
  feeBps: vi.fn(async () => 100),
  checkTrustline: vi.fn(),
  addTrustline: vi.fn(async () => "tx-add-trustline"),
  cancel: vi.fn(),
  setPaused: vi.fn(),
  readContract: vi.fn(async (_id: string, method: string) => {
    if (method === "symbol") return "USDC";
    if (method === "decimals") return 6;
    return null;
  }),
}));

vi.mock("@/lib/wallet", () => ({ useWallet: () => wallet }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    api: {
      ...apiMock,
      stream: vi.fn(() => null),
    },
    checkWebhookUrl: actual.checkWebhookUrl,
  };
});
vi.mock("@/lib/payflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/payflow")>()),
  payflow: payflowMock,
  readContract: payflowMock.readContract,
}));
vi.mock("@/lib/toml", () => ({ useOrgName: () => null }));
vi.mock("@/lib/chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain")>()),
  chainPlansOf: vi.fn(async () => []),
  chainMandatesFor: vi.fn(async () => []),
  chainMandatesOf: vi.fn(async () => []),
  chainMerchantSummary: vi.fn(() => ({
    total_volume: "0",
    collected_volume: "0",
    uncollected_volume: "0",
    active_mandates: 0,
    subscribers: 0,
  })),
  chainPlanSubscriberCount: vi.fn(async () => 0),
}));

function mandateWithToken(token: string): ApiMandate {
  return {
    id: 11,
    subscriber: SUBSCRIBER,
    merchant: MERCHANT,
    plan_id: 1,
    token,
    amount: "5000000", // 5 USDC
    period: 2_592_000,
    next_charge: 0,
    last_charge: 0,
    charges_made: 0,
    max_charges: 0,
    fee_bps: 100,
    status: "Active",
  };
}

describe("Multi-token plans & trustline prompt (#31)", () => {
  beforeEach(() => {
    wallet.address = MERCHANT;
    apiMock.plans.mockResolvedValue({ plans: [] });
    apiMock.mandatesFor.mockResolvedValue({ mandates: [] });
    apiMock.merchantSummary.mockResolvedValue({
      total_volume: "0",
      collected_volume: "0",
      uncollected_volume: "0",
      active_mandates: 0,
      subscribers: 0,
    });
    apiMock.planStats.mockResolvedValue({});
    apiMock.merchantRevenue.mockResolvedValue({ points: [] });
    apiMock.merchantChurn.mockResolvedValue({ months: [] });
    apiMock.merchantCohortRetention.mockResolvedValue(null);
    payflowMock.createPlan.mockReset();
    payflowMock.checkTrustline.mockReset();
    payflowMock.addTrustline.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("merchant can select USDC from the token dropdown and publish a USDC plan", async () => {
    render(<MerchantPage />);

    const tokenSelect = (await screen.findByLabelText(/Token/i)) as HTMLSelectElement;
    expect(tokenSelect).toBeTruthy();

    // Select USDC
    fireEvent.change(tokenSelect, { target: { value: USDC_SAC_CONTRACT } });
    expect(tokenSelect.value).toBe(USDC_SAC_CONTRACT);

    // Label reflects selected token (USDC) once metadata resolves
    expect(await screen.findByText(/Price \(USDC\)/i)).toBeTruthy();

    // Fill form
    fireEvent.change(screen.getByLabelText(/Price \(USDC\)/i), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/Plan name/i), { target: { value: "Pro USDC" } });

    const publishBtn = screen.getByRole("button", { name: "Publish plan" }) as HTMLButtonElement;
    expect(publishBtn.disabled).toBe(false);
    fireEvent.click(publishBtn);

    expect(payflowMock.createPlan).toHaveBeenCalledWith(
      MERCHANT,
      wallet.signXdr,
      expect.objectContaining({
        token: USDC_SAC_CONTRACT,
        name: "Pro USDC",
        amount: 10_000_000n, // 10 USDC (6 decimals)
      }),
    );
  });

  it("subscriber sees trustline prompt and can add trustline when lacking one for USDC", async () => {
    wallet.address = SUBSCRIBER;
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandateWithToken(USDC_SAC_CONTRACT)] });
    apiMock.vaultHistory.mockResolvedValue({ events: [] });
    // Subscriber lacks USDC trustline
    payflowMock.checkTrustline.mockResolvedValue(false);

    render(<AccountPage />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Trustline required for USDC/i)).toBeTruthy();

    const addBtn = screen.getByRole("button", { name: "Add USDC trustline" });
    expect(addBtn).toBeTruthy();

    fireEvent.click(addBtn);

    expect(payflowMock.addTrustline).toHaveBeenCalledWith(
      SUBSCRIBER,
      wallet.signXdr,
      "USDC",
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    );
  });
});
