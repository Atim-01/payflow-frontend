// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MerchantPage from "@/app/merchant/page";

/**
 * The publish form used to accept any text as a price and only fail when the
 * transaction was simulated, so a merchant paid for a failed attempt. These
 * tests pin the two acceptance criteria: invalid input disables Publish with a
 * message, and the fee preview is bigint math rather than a percentage of a
 * rounded display string.
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
  setPlanActive: vi.fn(),
  charge: vi.fn(),
  endMandate: vi.fn(),
  merchantPlanCount: vi.fn(),
  deactivatePage: vi.fn(),
  vaultBalance: vi.fn(),
  getMandate: vi.fn(),
}));

const chainMock = vi.hoisted(() => ({
  chainMandatesFor: vi.fn(),
  chainMerchantSummary: vi.fn(),
  chainPlansOf: vi.fn(),
  chainPlanSubscriberCount: vi.fn(),
  endable: vi.fn(() => false),
  mandateFunding: vi.fn(() => ({ status: "funded", shortfall: 0n })),
}));

vi.mock("@/lib/wallet", () => ({ useWallet: () => wallet }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { api: apiMock, checkWebhookUrl: actual.checkWebhookUrl };
});
vi.mock("@/lib/payflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payflow")>();
  return { payflow: payflowMock, MAX_NAME_LEN: 64, MAX_PAGE: actual.MAX_PAGE, nameByteLength: (n: string) => n.length, mandateSupportsRefund: actual.mandateSupportsRefund, mandateRefundableAmount: actual.mandateRefundableAmount, mandatePauseUntil: actual.mandatePauseUntil };
});
vi.mock("@/lib/chain", () => chainMock);

const MERCHANT = "GCH5VHWNS24VI75HLDBHK4SSJ2E5XZA5IB6XEZTNE4BJH7AKZI6Z3MHU";

beforeEach(() => {
  wallet.address = MERCHANT;
  wallet.networkMismatch = false;
  apiMock.isConfigured.mockReturnValue(true);
  apiMock.plans.mockResolvedValue({ plans: [] });
  apiMock.mandatesFor.mockResolvedValue({ mandates: [] });
  apiMock.merchantSummary.mockResolvedValue(null);
  apiMock.merchantRevenue.mockResolvedValue(null);
  apiMock.merchantChurn.mockResolvedValue(null);
  apiMock.merchantCohortRetention.mockResolvedValue(null);
  apiMock.planStats.mockResolvedValue(null);
  apiMock.webhooks.mockResolvedValue([]);
  chainMock.chainPlanSubscriberCount.mockResolvedValue(null);
  chainMock.mandateFunding.mockReturnValue({ status: "funded", shortfall: 0n });
  payflowMock.feeBps.mockResolvedValue(100); // 1%
  payflowMock.createPlan.mockResolvedValue("tx-hash");
  payflowMock.vaultBalance.mockResolvedValue(10_000_000n);
  payflowMock.getMandate.mockResolvedValue({
    id: 1,
    subscriber: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    merchant: MERCHANT,
    plan_id: 1,
    token: "",
    amount: 10_000_000n,
    period: 2_592_000n,
    next_charge: 0n,
    last_charge: 0n,
    charges_made: 0,
    max_charges: 0,
    fee_bps: 100,
    status: ["Active"],
    discount_bps: 0,
    discount_charges: 0,
  });
  chainMock.chainMerchantSummary.mockReturnValue({
    merchant: MERCHANT,
    activeMandates: 0,
    totalCollected: null,
    chargeCount: 0,
    mrr: "0",
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Type into the price field and return the Publish button. */
async function fillPrice(value: string): Promise<HTMLButtonElement> {
  const field = (await screen.findByLabelText(/price/i)) as HTMLInputElement;
  fireEvent.change(field, { target: { value } });
  return screen.getByRole("button", { name: /publish plan/i }) as HTMLButtonElement;
}

/** Switch the billing-period picker to Custom and set the count (and unit). */
async function chooseCustom(count: string, unit = "day"): Promise<void> {
  fireEvent.change(await screen.findByLabelText(/billing period/i), {
    target: { value: "custom" },
  });
  fireEvent.change(screen.getByLabelText(/custom period/i), { target: { value: count } });
  if (unit !== "day") {
    fireEvent.change(screen.getByLabelText(/^unit$/i), { target: { value: unit } });
  }
}

describe("MerchantPage publish form", () => {
  it("keeps Publish disabled and explains why while the price is unusable", async () => {
    render(<MerchantPage />);

    // An untouched empty field is not an error yet, but Publish stays off.
    const empty = await fillPrice("");
    expect(empty.disabled).toBe(true);
    expect(screen.queryByText("Enter an amount.")).toBeNull();

    // Letters are stripped at the keyboard now, so the garbage that reaches
    // the parser is a malformed number like 1.2.3 (issue #46's filter).
    fireEvent.change(screen.getByLabelText(/price/i), { target: { value: "1.2.3" } });
    expect(
      (screen.getByRole("button", { name: /publish plan/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Enter a positive number/i)).toBeTruthy();
  });

  it("explains the empty field once the merchant has blurred it", async () => {
    render(<MerchantPage />);
    const field = (await screen.findByLabelText(/price/i)) as HTMLInputElement;
    fireEvent.blur(field);

    expect(screen.getByText("Enter an amount.")).toBeTruthy();
  });

  it("rejects more decimal places than the token can represent", async () => {
    render(<MerchantPage />);

    const publish = await fillPrice("1.00000001");
    expect(publish.disabled).toBe(true);
    expect(screen.getByText(/At most 7 decimal places\./i)).toBeTruthy();
  });

  it("accepts the separators the merchant's locale uses", async () => {
    // Issue #46: a comma-decimal keyboard produces "1,5" or "1.234,5";
    // both must publish the same bigint as their dot-decimal twins.
    render(<MerchantPage />);

    const publish = await fillPrice("1.234,5");
    expect(publish.disabled).toBe(false);

    fireEvent.click(publish);
    await waitFor(() => expect(payflowMock.createPlan).toHaveBeenCalled());
    expect(payflowMock.createPlan.mock.calls[0]?.[2]).toMatchObject({
      amount: 12_345_000_000n,
    });
  });

  it("rejects a price of zero, which the contract would reject too", async () => {
    render(<MerchantPage />);

    const publish = await fillPrice("0");
    expect(publish.disabled).toBe(true);
    expect(screen.getByText("Amount must be greater than zero.")).toBeTruthy();
    expect(payflowMock.createPlan).not.toHaveBeenCalled();
  });

  it("marks the field invalid and points it at the message for screen readers", async () => {
    render(<MerchantPage />);
    await fillPrice("1.2.3");

    const field = screen.getByLabelText(/price/i);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const describedBy = field.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toMatch(
      /Enter a positive number/i,
    );
  });

  it("previews the fee split in bigint, not a percentage of a rounded display", async () => {
    render(<MerchantPage />);
    // 0.1 XLM at 1% is a fee of exactly 0.001 XLM. Rounding to 4dp for display
    // before taking the percentage would give 0.00099, and the merchant would
    // never see a charge they could reconcile.
    await fillPrice("0.1");

    await waitFor(() =>
      expect(screen.getByText(/you receive/)).toBeTruthy(),
    );
    const preview = document.getElementById("price-preview")?.textContent ?? "";
    expect(preview).toContain("Subscriber pays 0.1 XLM");
    expect(preview).toContain("protocol fee 0.001 XLM (1%)");
    expect(preview).toContain("you receive 0.099 XLM");
  });

  it("publishes the parsed amount rather than re-reading the field", async () => {
    render(<MerchantPage />);
    // "1." passes validation as an unfinished entry; re-parsing it would throw
    // after the merchant had already approved the transaction in their wallet.
    await fillPrice("1.");
    payflowMock.createPlan.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /publish plan/i }));

    await waitFor(() => expect(payflowMock.createPlan).toHaveBeenCalled());
    expect(payflowMock.createPlan.mock.calls[0]?.[2]).toMatchObject({ amount: 10_000_000n });
  });

  it("still previews a 0% split when the contract fee cannot be read", async () => {
    payflowMock.feeBps.mockRejectedValue(new Error("RPC down"));
    render(<MerchantPage />);

    await fillPrice("5");

    await waitFor(() => expect(screen.getByText(/you receive/)).toBeTruthy());
    expect(document.getElementById("price-preview")?.textContent).toContain("you receive 5 XLM");
    // The form is still usable: an unreadable fee must not block publishing.
    expect(screen.getByRole("button", { name: /publish plan/i }).hasAttribute("disabled")).toBe(
      false,
    );
  });
});

/**
 * Issue #29: five fixed periods meant a merchant billing fortnightly or
 * quarterly could not use Payflow. The picker keeps those five and adds
 * Custom; these tests pin the conversion to whole seconds and the acceptance
 * criterion — a below-minimum period is rejected in the form, with the
 * contract's wording, so the wallet never opens for a doomed publish.
 */
describe("MerchantPage period picker", () => {
  it("offers the original five presets plus Custom, opening on monthly", async () => {
    render(<MerchantPage />);

    const select = (await screen.findByLabelText(/billing period/i)) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Every minute (demo)",
      "Daily",
      "Weekly",
      "Monthly",
      "Yearly",
      "Custom…",
    ]);
    expect(select.value).toBe("2592000");
    // Nothing custom is on screen until it is asked for.
    expect(screen.queryByLabelText(/custom period/i)).toBeNull();
  });

  it("publishes a fortnightly period once Custom is chosen", async () => {
    render(<MerchantPage />);

    const publish = await fillPrice("1");
    await chooseCustom("2", "week");

    expect(publish.disabled).toBe(false);
    fireEvent.click(publish);

    await waitFor(() => expect(payflowMock.createPlan).toHaveBeenCalled());
    expect(payflowMock.createPlan.mock.calls[0]?.[2]).toMatchObject({ period: 1_209_600 });
  });

  it("publishes a quarterly period counted in months", async () => {
    render(<MerchantPage />);

    const publish = await fillPrice("1");
    await chooseCustom("3", "month");

    expect(publish.disabled).toBe(false);
    fireEvent.click(publish);

    await waitFor(() => expect(payflowMock.createPlan).toHaveBeenCalled());
    expect(payflowMock.createPlan.mock.calls[0]?.[2]).toMatchObject({ period: 7_776_000 });
  });

  it("still publishes the monthly default when Custom is never chosen", async () => {
    render(<MerchantPage />);

    const publish = await fillPrice("1");
    fireEvent.click(publish);

    await waitFor(() => expect(payflowMock.createPlan).toHaveBeenCalled());
    expect(payflowMock.createPlan.mock.calls[0]?.[2]).toMatchObject({ period: 2_592_000 });
  });

  it("rejects a below-minimum custom period with the contract's own words", async () => {
    render(<MerchantPage />);

    const publish = await fillPrice("1");
    await chooseCustom("0");

    expect(publish.disabled).toBe(true);
    expect(screen.getByText("Billing period must be at least 60 seconds.")).toBeTruthy();
    // Disabled buttons swallow clicks, so this stays an unsubmitted form even
    // if something re-dispatches one.
    fireEvent.click(publish);
    expect(payflowMock.createPlan).not.toHaveBeenCalled();
  });

  it("keeps Publish off for an empty custom count and says what is missing", async () => {
    render(<MerchantPage />);

    const publish = await fillPrice("1");
    await chooseCustom("");

    // Choosing Custom is itself the request for a period, so the form names
    // the gap at once rather than waiting to be told — but nothing below the
    // 60-second floor (an uncomputed period included) can be published.
    expect(publish.disabled).toBe(true);
    expect(screen.getByText("Enter a whole number of days.")).toBeTruthy();
  });

  it("points a bad custom count at its message for screen readers", async () => {
    render(<MerchantPage />);
    await fillPrice("1");
    await chooseCustom("0");

    const field = screen.getByLabelText(/custom period/i);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const describedBy = field.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      "Billing period must be at least 60 seconds.",
    );
  });

  it("rejects a fractional count and names the unit in the message", async () => {
    render(<MerchantPage />);

    const publish = await fillPrice("1");
    await chooseCustom("2.5");

    expect(publish.disabled).toBe(true);
    expect(screen.getByText("Enter a whole number of days.")).toBeTruthy();

    // Changing the unit re-labels the complaint: the count is still unusable,
    // and the message still names the unit now selected.
    fireEvent.change(screen.getByLabelText(/^unit$/i), { target: { value: "week" } });
    expect(screen.getByText("Enter a whole number of weeks.")).toBeTruthy();
  });

  it("lets the merchant change their mind back to a preset", async () => {
    render(<MerchantPage />);

    const publish = await fillPrice("1");
    await chooseCustom("0");
    expect(publish.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/billing period/i), { target: { value: "604800" } });
    expect(screen.queryByLabelText(/custom period/i)).toBeNull();
    expect(publish.disabled).toBe(false);

    fireEvent.click(publish);
    await waitFor(() => expect(payflowMock.createPlan).toHaveBeenCalled());
    expect(payflowMock.createPlan.mock.calls[0]?.[2]).toMatchObject({ period: 604_800 });
  });
});

/**
 * Deactivate all plans (issue #172).
 *
 * The plan registry can deactivate a page of a merchant's plans in one call
 * (deactivate_page). The UI confirms the action with the number of active
 * plans and open mandates affected, then pages through with deactivate_page.
 * Progress is shown for merchants with more than one page.
 */
describe("MerchantPage deactivate all plans", () => {
  /** Shared setup for tests that need active plans and mandates. */
  function setupActivePlans() {
    apiMock.plans.mockResolvedValue({
      plans: [
        { id: 1, merchant: MERCHANT, name: "Plan 1", token: "", amount: "10000000", period: 2_592_000, active: 1, ledger: 0 },
        { id: 2, merchant: MERCHANT, name: "Plan 2", token: "", amount: "20000000", period: 2_592_000, active: 1, ledger: 0 },
        { id: 3, merchant: MERCHANT, name: "Plan 3", token: "", amount: "30000000", period: 2_592_000, active: 0, ledger: 0 },
      ],
    });
    apiMock.mandatesFor.mockResolvedValue({
      mandates: [
        { id: 10, subscriber: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", merchant: MERCHANT, plan_id: 1, amount: "10000000", period: 2_592_000, next_charge: Math.floor(Date.now() / 1000) + 86_400, last_charge: 0, charges_made: 0, max_charges: 0, fee_bps: 100, status: "Active", token: "" },
        { id: 11, subscriber: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF", merchant: MERCHANT, plan_id: 2, amount: "20000000", period: 2_592_000, next_charge: Math.floor(Date.now() / 1000) + 86_400, last_charge: 0, charges_made: 0, max_charges: 0, fee_bps: 100, status: "Active", token: "" },
      ],
    });
    chainMock.chainPlanSubscriberCount.mockResolvedValue(null);
    chainMock.chainMerchantSummary.mockReturnValue({
      merchant: MERCHANT,
      activeMandates: 2,
      totalCollected: null,
      chargeCount: 0,
      mrr: "0",
    });
    payflowMock.feeBps.mockResolvedValue(100);
    payflowMock.merchantPlanCount.mockResolvedValue(3);
    payflowMock.deactivatePage.mockResolvedValue("tx-hash");
  }

  /** Wait for the plans list to render (not just the panel header). */
  async function waitForPlans() {
    await screen.findByText("Plan 1");
    await screen.findByText("Plan 2");
  }

  /** A promise the test settles explicitly, to assert in-flight UI. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("shows the deactivate all button when there are active plans", async () => {
    setupActivePlans();
    render(<MerchantPage />);

    await waitForPlans();
    expect(await screen.findByRole("button", { name: "Deactivate all plans" })).toBeTruthy();
  });

  it("opens a confirmation dialog with active plan count and open mandates", async () => {
    setupActivePlans();
    render(<MerchantPage />);

    await waitForPlans();
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate all plans" }));

    const dialog = await screen.findByRole("dialog", { name: "Deactivate all active plans" });
    expect(dialog.textContent).toContain("This will deactivate 2 active plans");
    expect(dialog.textContent).toContain("Affected open subscriptions: 2 mandates");
  });

  it("calls deactivate_page for each page and shows progress", async () => {
    setupActivePlans();
    const page = deferred<string>();
    payflowMock.deactivatePage.mockReturnValueOnce(page.promise);

    render(<MerchantPage />);

    await waitForPlans();
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate all plans" }));

    await screen.findByRole("dialog", { name: "Deactivate all active plans" });
    fireEvent.click(screen.getByRole("button", { name: "Confirm: deactivate all" }));

    // The call is in flight: the dialog shows the first page in progress.
    await waitFor(() =>
      expect(payflowMock.deactivatePage).toHaveBeenCalledWith(MERCHANT, wallet.signXdr, 0, 3),
    );
    expect(screen.getByRole("button", { name: /Deactivating… \(0\/1 pages\)/ })).toBeTruthy();

    page.resolve("tx-hash");
    await waitFor(() => expect(screen.getByText("All active plans deactivated.")).toBeTruthy());
    expect(payflowMock.deactivatePage).toHaveBeenCalledTimes(1);
  });

  it("pages through multiple pages when plan count exceeds MAX_PAGE", async () => {
    // 60 plans = 2 pages (MAX_PAGE=50)
    setupActivePlans();
    // Override with 60 active plans
    apiMock.plans.mockResolvedValue({
      plans: Array.from({ length: 60 }, (_, i) => ({
        id: i + 1,
        merchant: MERCHANT,
        name: `Plan ${i + 1}`,
        token: "",
        amount: "10000000",
        period: 2_592_000,
        active: 1,
        ledger: 0,
      })),
    });
    apiMock.mandatesFor.mockResolvedValue({ mandates: [] });
    chainMock.chainMerchantSummary.mockReturnValue({
      merchant: MERCHANT,
      activeMandates: 0,
      totalCollected: null,
      chargeCount: 0,
      mrr: "0",
    });
    payflowMock.merchantPlanCount.mockResolvedValue(60);
    const first = deferred<string>();
    const second = deferred<string>();
    payflowMock.deactivatePage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    render(<MerchantPage />);

    await screen.findByRole("button", { name: "Deactivate all plans" });
    fireEvent.click(screen.getByRole("button", { name: "Deactivate all plans" }));

    await screen.findByRole("dialog", { name: "Deactivate all active plans" });
    fireEvent.click(screen.getByRole("button", { name: "Confirm: deactivate all" }));

    // First page, 50 plans, still in flight.
    await waitFor(() =>
      expect(payflowMock.deactivatePage).toHaveBeenCalledWith(MERCHANT, wallet.signXdr, 0, 50),
    );
    expect(screen.getByRole("button", { name: /Deactivating… \(0\/2 pages\)/ })).toBeTruthy();

    // Second page, the remaining 10 plans.
    first.resolve("tx-hash");
    await waitFor(() =>
      expect(payflowMock.deactivatePage).toHaveBeenCalledWith(MERCHANT, wallet.signXdr, 50, 10),
    );
    expect(screen.getByRole("button", { name: /Deactivating… \(1\/2 pages\)/ })).toBeTruthy();

    // Completion.
    second.resolve("tx-hash");
    await waitFor(() => expect(screen.getByText("All active plans deactivated.")).toBeTruthy());
    expect(payflowMock.deactivatePage).toHaveBeenCalledTimes(2);
  });

  it("hides the button when there are no active plans", async () => {
    apiMock.plans.mockResolvedValue({
      plans: [
        { id: 1, merchant: MERCHANT, name: "Plan 1", token: "", amount: "10000000", period: 2_592_000, active: 0, ledger: 0 },
        { id: 2, merchant: MERCHANT, name: "Plan 2", token: "", amount: "20000000", period: 2_592_000, active: 0, ledger: 0 },
      ],
    });
    apiMock.mandatesFor.mockResolvedValue({ mandates: [] });
    chainMock.chainPlanSubscriberCount.mockResolvedValue(null);
    chainMock.chainMerchantSummary.mockReturnValue({
      merchant: MERCHANT,
      activeMandates: 0,
      totalCollected: null,
      chargeCount: 0,
      mrr: "0",
    });
    payflowMock.feeBps.mockResolvedValue(100);

    render(<MerchantPage />);

    await screen.findByText("Plan 1");
    expect(screen.queryByRole("button", { name: "Deactivate all plans" })).toBeNull();
  });

  it("hides the button when network mismatch", async () => {
    setupActivePlans();
    wallet.networkMismatch = true;
    render(<MerchantPage />);

    await waitForPlans();
    // Button should not render at all when network mismatch
    expect(screen.queryByRole("button", { name: "Deactivate all plans" })).toBeNull();
  });

  it("hides the button while busy (after confirmation)", async () => {
    setupActivePlans();
    const page = deferred<string>();
    payflowMock.deactivatePage.mockReturnValueOnce(page.promise);
    render(<MerchantPage />);

    await waitForPlans();
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate all plans" }));

    await screen.findByRole("dialog", { name: "Deactivate all active plans" });
    fireEvent.click(screen.getByRole("button", { name: "Confirm: deactivate all" }));

    // While a run is in flight the panel button cannot re-open the dialog.
    await waitFor(() => expect(payflowMock.deactivatePage).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Deactivate all plans" })).toBeNull();
    const confirmButton = screen.getByRole("button", { name: /Deactivating…/ }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    page.resolve("tx-hash");
    await waitFor(() => expect(screen.getByText("All active plans deactivated.")).toBeTruthy());
  });

  it("shows error when deactivate_page fails", async () => {
    setupActivePlans();
    payflowMock.deactivatePage.mockRejectedValue(new Error("RPC error"));

    render(<MerchantPage />);

    await waitForPlans();
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate all plans" }));

    await screen.findByRole("dialog", { name: "Deactivate all active plans" });
    fireEvent.click(screen.getByRole("button", { name: "Confirm: deactivate all" }));

    await waitFor(() => expect(screen.getByText("RPC error")).toBeTruthy());
    expect(screen.queryByText("All active plans deactivated.")).toBeNull();
  });
});
