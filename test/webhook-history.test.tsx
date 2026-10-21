// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatExactTime } from "@/i18n/format";
import { WebhookDeliveryHistory } from "@/components/WebhookDeliveryHistory";

const mocks = vi.hoisted(() => ({
  wallet: { address: "GA" as string | null, networkMismatch: false },
  configured: vi.fn(() => true), load: vi.fn(), sign: vi.fn(),
}));
vi.mock("@/lib/wallet", () => ({ useWallet: () => mocks.wallet }));
vi.mock("@/lib/api", () => ({ api: { isConfigured: mocks.configured, webhookDeliveries: mocks.load } }));
vi.mock("@/lib/config", () => ({ config: { networkPassphrase: "Testnet" } }));
vi.mock("@/lib/sign-webhook-proof", () => ({ signWebhookProof: mocks.sign }));
const failed = { id: 1, event_id: "charge:abc", status: "pending", http_status: 503, error: "Service unavailable", attempt: 1, retry_at: 1792584000 };
function view(merchant = "GA", webhookId = "12") { return <WebhookDeliveryHistory merchant={merchant} webhookId={webhookId} />; }
function refresh() { fireEvent.click(screen.getByRole("button", { name: "Refresh delivery history for webhook 12" })); }
beforeEach(() => {
  vi.resetAllMocks(); mocks.wallet.address = "GA"; mocks.wallet.networkMismatch = false;
  mocks.configured.mockReturnValue(true); mocks.sign.mockResolvedValue("signature");
  mocks.load.mockResolvedValue([failed, { ...failed, id: 2, status: "delivered", http_status: 200, error: null, attempt: 2, retry_at: null }]);
});
afterEach(cleanup);

describe("webhook history controls", () => {
  it("is hidden without an API and does not prompt automatically", () => {
    mocks.configured.mockReturnValue(false);
    const { container, rerender } = render(view()); expect(container.innerHTML).toBe("");
    mocks.configured.mockReturnValue(true); rerender(view());
    expect(screen.getByRole("button")).toBeTruthy();
    expect(mocks.sign).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled();
  });
  it.each(["disconnected", "wrong account", "wrong network"])("does not sign while %s", (state) => {
    mocks.wallet.address = state === "disconnected" ? null : state === "wrong account" ? "GB" : "GA";
    mocks.wallet.networkMismatch = state === "wrong network";
    render(view()); expect(screen.queryByRole("button")).toBeNull(); expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("shows separate attempts, explicit failure text, status codes and UTC retries", async () => {
    render(view()); refresh();
    expect(await screen.findByText("Failed — retry pending")).toBeTruthy();
    expect(screen.getByText("Delivered")).toBeTruthy();
    expect(screen.getAllByText("charge:abc")).toHaveLength(2);
    expect(screen.getByText("503")).toBeTruthy(); expect(screen.getByText("200")).toBeTruthy();
    expect(screen.getByText(formatExactTime(failed.retry_at, "en"))).toBeTruthy();
    expect(mocks.sign).toHaveBeenCalledWith(expect.stringContaining('"GA","12"'), "GA");
    expect(mocks.load).toHaveBeenCalledWith("12", expect.objectContaining({ merchant: "GA", signature: "signature" }), expect.any(AbortSignal));
    mocks.load.mockResolvedValueOnce([]); refresh();
    expect(await screen.findByText("No deliveries yet.")).toBeTruthy(); expect(screen.queryByText("503")).toBeNull();
  });
  it("distinguishes unavailable history and permits retry", async () => {
    mocks.load.mockResolvedValueOnce(null); render(view()); refresh();
    expect(await screen.findByRole("alert")).toBeTruthy(); expect(screen.queryByText("No deliveries yet.")).toBeNull();
    await waitFor(() => expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false));
    refresh(); expect(await screen.findByText("Delivered")).toBeTruthy();
  });
  it("does not fetch when signing is declined", async () => {
    mocks.sign.mockRejectedValueOnce(new Error("You cancelled the signature. Nothing was sent."));
    render(view()); refresh(); expect(await screen.findByRole("alert")).toHaveProperty("textContent", "You cancelled the signature. Nothing was sent.");
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("does not fetch with a signature completed after an account change", async () => {
    let resolve!: (value: string) => void;
    mocks.sign.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
    const { rerender } = render(view()); refresh();
    mocks.wallet.address = "GB"; rerender(view("GB"));
    await act(async () => resolve("old-proof")); expect(mocks.load).not.toHaveBeenCalled();
  });
  it.each(["account", "network", "disconnect"])("aborts late responses after %s changes", async (change) => {
    let resolve!: (value: unknown) => void;
    mocks.load.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { rerender } = render(view()); refresh(); await waitFor(() => expect(mocks.load).toHaveBeenCalled());
    const signal = mocks.load.mock.calls[0]![2] as AbortSignal;
    if (change === "network") mocks.wallet.networkMismatch = true;
    else mocks.wallet.address = change === "account" ? "GB" : null;
    rerender(view(change === "account" ? "GB" : "GA"));
    expect(signal.aborted).toBe(true);
    await act(async () => resolve([failed])); expect(screen.queryByText("charge:abc")).toBeNull();
  });
});
