// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MerchantPage from "@/app/merchant/page";
import type { ApiMandate } from "@/lib/api";

/**
 * The discount a merchant attaches to one mandate (issue #115).
 *
 * The contract that carries the discount has not shipped, so the control has
 * to stay hidden while the deployed contract cannot answer — and appear as
 * soon as it can. The rate is limited to whole basis points, and the rate
 * that reaches the contract is the one the merchant typed.
 */

const MERCHANT = "GCH5VHWNS24VI75HLDBHK4SSJ2E5XZA5IB6XEZTNE4BJH7AKZI6Z3MHU";
const SUBSCRIBER = "GAP6QFLXQD73URCC3EXU2WOQHIAREPCGMSIMKF5PFLLI5TR6HTMNDTIE";

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
  stream: vi.fn(),
  webhooks: vi.fn(),
  addWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  testWebhook: vi.fn(),
}));

const payflowMock = vi.hoisted(() => ({
  feeBps: vi.fn(),
  createPlan: vi.fn(),
  setPlanActive: vi.fn(),
  charge: vi.fn(),
  endMandate: vi.fn(),
  setDiscount: vi.fn(),
  getMandate: vi.fn(),
  vaultBalance: vi.fn(),
}));

const chainMock = vi.hoisted(() => ({
  chainMandatesFor: vi.fn(),
  chainMerchantSummary: vi.fn(),
  chainPlansOf: vi.fn(),
  endable: vi.fn(() => true),
}));

vi.mock("@/lib/wallet", () => ({ useWallet: () => wallet }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { api: apiMock, checkWebhookUrl: actual.checkWebhookUrl };
});
vi.mock("@/lib/payflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/payflow")>()),
  payflow: payflowMock,
  MAX_NAME_LEN: 64,
  nameByteLength: (n: string) => n.length,
  mandateSupportsRefund: () => false,
  mandateRefundableAmount: () => null,
}));
vi.mock("@/lib/chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain")>()),
  chainMandatesFor: chainMock.chainMandatesFor,
  chainMerchantSummary: chainMock.chainMerchantSummary,
  chainPlansOf: chainMock.chainPlansOf,
}));
vi.mock("@/lib/token", () => ({
  metaFor: () => ({ symbol: "XLM", decimals: 7 }),
  useTokenMetas: () => new Map(),
}));
vi.mock("@/lib/toml", () => ({ useOrgName: () => "Acme Payments" }));

function mandate(overrides: Partial<ApiMandate> = {}): ApiMandate {
  return {
    id: 7,
    subscriber: SUBSCRIBER,
    merchant: MERCHANT,
    plan_id: 1,
    amount: "10000000",
    period: 2_592_000,
    next_charge: Math.floor(Date.now() / 1000) + 86_400,
    last_charge: 0,
    charges_made: 1,
    max_charges: 0,
    fee_bps: 100,
    status: "Active",
    token: "",
    ...overrides,
  };
}

beforeEach(() => {
  wallet.address = MERCHANT;
  wallet.networkMismatch = false;
  apiMock.isConfigured.mockReturnValue(true);
  apiMock.plans.mockResolvedValue({ plans: [] });
  apiMock.mandatesFor.mockResolvedValue({ mandates: [mandate()] });
  apiMock.merchantSummary.mockResolvedValue(null);
  apiMock.merchantRevenue.mockResolvedValue(null);
  apiMock.merchantChurn.mockResolvedValue(null);
  apiMock.merchantCohortRetention.mockResolvedValue(null);
  apiMock.webhooks.mockResolvedValue([]);
  payflowMock.feeBps.mockResolvedValue(100);
  payflowMock.vaultBalance.mockResolvedValue(10_000_000n);
  payflowMock.setDiscount.mockResolvedValue("tx-hash");
  // A contract without the discount fields: the feature is not there yet.
  payflowMock.getMandate.mockResolvedValue({
    id: 7,
    subscriber: SUBSCRIBER,
    merchant: MERCHANT,
    plan_id: 1,
    token: "",
    amount: 10_000_000n,
    period: 2_592_000n,
    next_charge: 0n,
    last_charge: 0n,
    charges_made: 1,
    max_charges: 0,
    fee_bps: 100,
    status: ["Active"],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MerchantPage discount", () => {
  it("hides the control while the contract cannot carry a discount", async () => {
    render(<MerchantPage />);

    await screen.findByText("#7");
    await waitFor(() => expect(payflowMock.getMandate).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Discount" })).toBeNull();
  });

  it("offers the control once the contract can carry a discount", async () => {
    payflowMock.getMandate.mockResolvedValue({
      id: 7,
      subscriber: SUBSCRIBER,
      merchant: MERCHANT,
      plan_id: 1,
      token: "",
      amount: 10_000_000n,
      period: 2_592_000n,
      next_charge: 0n,
      last_charge: 0n,
      charges_made: 1,
      max_charges: 0,
      fee_bps: 100,
      status: ["Active"],
      discount_bps: 0,
      discount_charges: 0,
    });
    render(<MerchantPage />);

    expect(await screen.findByRole("button", { name: "Discount" })).toBeTruthy();
  });

  it("takes the discount from the rows it already has", async () => {
    // The indexer may carry the discount itself: no extra read is needed.
    // The refund support check will call getMandate because the indexer
    // does not yet project refundable_amount, but the discount check
    // uses the data already in the row.
    apiMock.mandatesFor.mockResolvedValue({
      mandates: [mandate({ discount_bps: 2000, discount_charges: 3 })],
    });
    render(<MerchantPage />);

    expect(await screen.findByRole("button", { name: "Discount" })).toBeTruthy();
    // The discount control uses the row data; the refund control may call getMandate
    // to check refund support, so we don't assert on that here.
    expect(screen.getByText("20% off for 3 charges")).toBeTruthy();
  });

  it("limits the rate to whole basis points", async () => {
    payflowMock.getMandate.mockResolvedValue({
      id: 7,
      subscriber: SUBSCRIBER,
      merchant: MERCHANT,
      plan_id: 1,
      token: "",
      amount: 10_000_000n,
      period: 2_592_000n,
      next_charge: 0n,
      last_charge: 0n,
      charges_made: 1,
      max_charges: 0,
      fee_bps: 100,
      status: ["Active"],
      discount_bps: 0,
    });
    render(<MerchantPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Discount" }));
    const percent = (await screen.findByLabelText(/discount \(%\)/i)) as HTMLInputElement;
    const apply = screen.getByRole("button", { name: /apply discount/i }) as HTMLButtonElement;

    fireEvent.change(percent, { target: { value: "150" } });
    expect(screen.getByText(/cannot be 100% or more/i)).toBeTruthy();
    expect(apply.disabled).toBe(true);

    fireEvent.change(percent, { target: { value: "12.5" } });
    expect(screen.queryByText(/cannot be 100% or more/i)).toBeNull();
    expect(apply.disabled).toBe(false);
  });

  it("sends the rate in basis points and the number of charges", async () => {
    payflowMock.getMandate.mockResolvedValue({
      id: 7,
      subscriber: SUBSCRIBER,
      merchant: MERCHANT,
      plan_id: 1,
      token: "",
      amount: 10_000_000n,
      period: 2_592_000n,
      next_charge: 0n,
      last_charge: 0n,
      charges_made: 1,
      max_charges: 0,
      fee_bps: 100,
      status: ["Active"],
      discount_bps: 0,
    });
    render(<MerchantPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Discount" }));
    const percent = (await screen.findByLabelText(/discount \(%\)/i)) as HTMLInputElement;
    const charges = screen.getByLabelText(/charges to cover/i) as HTMLInputElement;
    fireEvent.change(percent, { target: { value: "12.5" } });
    fireEvent.change(charges, { target: { value: "3" } });

    fireEvent.click(screen.getByRole("button", { name: /apply discount/i }));

    await waitFor(() => expect(payflowMock.setDiscount).toHaveBeenCalled());
    expect(payflowMock.setDiscount).toHaveBeenCalledWith(
      MERCHANT,
      wallet.signXdr,
      7,
      1250,
      3,
    );
  });

  it("previews what the subscriber pays while the discount runs", async () => {
    payflowMock.getMandate.mockResolvedValue({
      id: 7,
      subscriber: SUBSCRIBER,
      merchant: MERCHANT,
      plan_id: 1,
      token: "",
      amount: 10_000_000n,
      period: 2_592_000n,
      next_charge: 0n,
      last_charge: 0n,
      charges_made: 1,
      max_charges: 0,
      fee_bps: 100,
      status: ["Active"],
      discount_bps: 0,
    });
    render(<MerchantPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Discount" }));
    const percent = (await screen.findByLabelText(/discount \(%\)/i)) as HTMLInputElement;
    fireEvent.change(percent, { target: { value: "20" } });

    // 1 XLM at 20% off is 0.8 XLM, in the token's own scale.
    expect(screen.getByText(/Subscriber pays 0.8 XLM/)).toBeTruthy();
    expect(screen.getByText(/then 1 XLM/)).toBeTruthy();
  });
});
