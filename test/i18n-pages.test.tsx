// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import HomePage from "@/app/page";
import SubscribePage from "@/app/subscribe/page";
import AccountPage from "@/app/account/page";
import MerchantPage from "@/app/merchant/page";
import { I18nProvider, LOCALE_STORAGE_KEY } from "@/i18n/provider";
import { LanguagePicker } from "@/i18n/LanguagePicker";
const state = vi.hoisted(() => ({ address: null as string | null, networkMismatch: false, configured: true }));
const plan = { id: 7, merchant: "merchant.fixture", name: "English merchant name", token: "", amount: "12345678901", period: 2592000, active: 1, ledger: 1, trial: 259200 };
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/wallet", () => ({ useWallet: () => ({ ...state, signXdr: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }) }));
vi.mock("@/lib/token", () => ({ useTokenMetas: () => new Map(), metaFor: () => ({ symbol: "XLM", decimals: 7 }) }));
vi.mock("@/lib/price", () => ({ useXlmUsdPrice: () => ({ priceData: null }), formatUsdEstimate: vi.fn(), formatUsdcEstimate: vi.fn() }));
vi.mock("@/lib/toml", () => ({ useOrgName: () => null }));
vi.mock("@/lib/api", async original => {
  const real = await original<typeof import("@/lib/api")>();
  return { ...real, api: {
    isConfigured: () => state.configured,
    stats: async () => state.configured ? { plans: 1234, mandates: 12, activeMandates: 4, charges: 9 } : null,
    recentCharges: async () => ({ charges: [] }),
    plans: async () => state.configured ? { plans: [plan] } : null,
    mandatesOf: async () => ({ mandates: [] }), mandatesFor: async () => ({ mandates: [] }),
    vaultHistory: async () => null, merchantSummary: async () => null,
    merchantRevenue: async () => null, merchantChurn: async () => null,
    merchantCohortRetention: async () => null,
    webhooks: async () => [], planStats: async () => null, stream: () => null,
  } };
});
vi.mock("@/lib/payflow", async original => {
  const real = await original<typeof import("@/lib/payflow")>();
  return { ...real, payflow: { ...real.payflow, vaultBalance: async () => 12345678901n, feeBps: async () => 100, getPlan: async () => null }, vaultSupportsDepositFor: async () => false };
});
vi.mock("@/lib/chain", async original => {
  const real = await original<typeof import("@/lib/chain")>();
  return { ...real, chainProtocolStats: async () => ({ plans: 1234 }), chainPlans: async () => [plan], chainPlansOf: async () => [plan], chainMandatesOf: async () => [], chainMandatesFor: async () => [], chainMerchantSummary: async () => null, chainPlanSubscriberCount: async () => null };
});
function App({ children }: { children: React.ReactNode }) { return <I18nProvider><LanguagePicker />{children}</I18nProvider>; }
beforeEach(() => { localStorage.clear(); localStorage.setItem(LOCALE_STORAGE_KEY, "fr"); state.address = null; state.networkMismatch = false; state.configured = true; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("French on the four main pages", () => {
  it("translates the overview instructions and number counters", async () => {
    render(<App><HomePage /></App>);
    await screen.findByText("Le marchand publie une offre");
    await screen.findByText(/^1\s234$/);
    expect(screen.queryByText("The merchant publishes a plan")).toBeNull();
  });
  it("translates plan controls, trial badges and money while preserving merchant names", async () => {
    render(<App><SubscribePage /></App>);
    await screen.findByText("English merchant name");
    await screen.findByText("Essai gratuit : 3 jours");
    expect(screen.getByLabelText("Période de facturation :")).toBeTruthy();
    expect(screen.getByText(/^1\s234,5678$/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Langue" }), { target: { value: "en" } });
    expect(screen.getByText("English merchant name")).toBeTruthy();
    expect(screen.getByLabelText("Billing period:")).toBeTruthy();
  });
  it("explains the disconnected account in French", async () => {
    render(<App><AccountPage /></App>);
    await screen.findByText("Aucun portefeuille connecté");
    expect(screen.queryByText("No wallet connected")).toBeNull();
  });
  it("shows the connected merchant form in French and keeps wrong-network writes disabled", async () => {
    state.address = "merchant.fixture"; state.networkMismatch = true;
    render(<App><MerchantPage /></App>);
    const publish = await screen.findByRole("button", { name: "Publier l’offre" });
    expect((publish as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText("Nom de l’offre")).toBeTruthy();
    expect(screen.getByText("Toutes les minutes (démo)")).toBeTruthy();
  });
  it("explains contract-only mode in French without depending on an indexer", async () => {
    state.configured = false;
    render(<App><SubscribePage /></App>);
    await screen.findByText("English merchant name");
    await waitFor(() => expect(screen.getByText(/Lecture directe des offres dans le contrat/)).toBeTruthy());
    expect(screen.queryByText(/Reading plans directly from the contract/)).toBeNull();
  });
});
