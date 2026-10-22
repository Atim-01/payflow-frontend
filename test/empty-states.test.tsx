// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Empty } from "@/components/ui";
import SubscribePage from "@/app/subscribe/page";
import AccountPage from "@/app/account/page";
import MerchantPage from "@/app/merchant/page";
import type { ApiPlan } from "@/lib/api";

/**
 * Empty states (issue: "No plans yet" with nothing to do next): every empty
 * list must explain the situation and offer the next action. The cases that
 * matter are the ones the app actually ships in — contract-only mode (no
 * indexer), a visitor with no wallet, and the deposit/subscribe/publish next
 * steps the pages point at.
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
  isConfigured: vi.fn(() => false),
  plans: vi.fn(),
  mandatesOf: vi.fn(),
  mandatesFor: vi.fn(),
  vaultHistory: vi.fn(),
  merchantSummary: vi.fn(),
  merchantRevenue: vi.fn(),
  merchantChurn: vi.fn(),
  merchantCohortRetention: vi.fn(),
  planStats: vi.fn(),
  webhooks: vi.fn(),
}));

const chainMock = vi.hoisted(() => ({
  chainPlans: vi.fn(),
  chainPlansOf: vi.fn(),
  chainMandatesOf: vi.fn(),
  chainMandatesFor: vi.fn(),
}));

const payflowMock = vi.hoisted(() => ({
  vaultBalance: vi.fn(),
  feeBps: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: unknown }) => (
    <a href={typeof href === "string" ? href : ""} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/wallet", () => ({ useWallet: () => wallet }));
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/chain", async (importOriginal) => ({
  // The real chain.ts needs MAX_PAGE, mandateStatus, etc. from payflow.
  ...(await importOriginal<typeof import("@/lib/chain")>()),
  chainPlans: chainMock.chainPlans,
  chainPlansOf: chainMock.chainPlansOf,
  chainMandatesOf: chainMock.chainMandatesOf,
  chainMandatesFor: chainMock.chainMandatesFor,
}));
vi.mock("@/lib/config", () => ({
  config: {
    rpcUrl: "http://localhost:8000/rpc",
    networkPassphrase: "Test SDF Network ; September 2015",
    network: "TESTNET",
    apiUrl: "",
    readSource: "GAKOHW5FUKSF3SXQQWLD647RQJPOR5RZOS4ITSMWC5NPC67DEXXYU43H",
    horizonUrl: "http://localhost:8081",
    contracts: {
      planRegistry: "CDQ5EJTVXXX2CBMHWP3BGGUDHSK6D4I25IF5XXH3QGL2TNTBMJUOFKDB",
      vault: "CBNQEWSYYQOKNX5KB62OFT6ID5TCVSWN4PS4AXAJK6IWUEXOLVN6DXII",
      subscription: "CD5YZUJU6WLFIHGAV4J2BV42GCVZE5ZGDUGSW5CBRIA47TQHSZZW3XMM",
      token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    },
  },
  explorerBase: "https://stellar.expert/explorer/testnet",
  requireContracts: () => {},
}));
vi.mock("@/lib/token", () => ({
  metaFor: () => ({ symbol: "XLM", decimals: 7 }),
  useTokenMetas: () => new Map(),
}));
vi.mock("@/lib/toml", () => ({ useOrgName: () => null }));
vi.mock("@/lib/payflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/payflow")>()),
  payflow: payflowMock,
}));

function plan(overrides: Partial<ApiPlan> = {}): ApiPlan {
  return {
    id: 1,
    merchant: MERCHANT,
    name: "Pro Monthly",
    token: "",
    amount: "10000000", // 1 XLM
    period: 2_592_000,
    active: 1,
    ledger: 0,
    ...overrides,
  };
}

beforeEach(() => {
  wallet.address = null;
  wallet.connecting = false;
  wallet.networkMismatch = false;
  wallet.connect.mockReset();
  apiMock.isConfigured.mockReturnValue(false);
  // Contract-only mode everywhere by default: every api call answers null and
  // the chain fallbacks return nothing.
  apiMock.plans.mockReset().mockResolvedValue(null);
  apiMock.mandatesOf.mockReset().mockResolvedValue(null);
  apiMock.mandatesFor.mockReset().mockResolvedValue(null);
  apiMock.vaultHistory.mockReset().mockResolvedValue(null);
  apiMock.merchantSummary.mockReset().mockResolvedValue(null);
  apiMock.merchantRevenue.mockReset().mockResolvedValue(null);
  apiMock.merchantChurn.mockReset().mockResolvedValue(null);
  apiMock.merchantCohortRetention.mockReset().mockResolvedValue(null);
  apiMock.planStats.mockReset().mockResolvedValue(null);
  apiMock.webhooks.mockReset().mockResolvedValue([]);
  apiMock.merchantCohortRetention.mockReset().mockResolvedValue(null);
  chainMock.chainPlans.mockReset().mockResolvedValue([]);
  chainMock.chainPlansOf.mockReset().mockResolvedValue([]);
  chainMock.chainMandatesOf.mockReset().mockResolvedValue([]);
  chainMock.chainMandatesFor.mockReset().mockResolvedValue([]);
  payflowMock.vaultBalance.mockReset().mockResolvedValue(0n);
  payflowMock.feeBps.mockReset().mockResolvedValue(500);
});

afterEach(cleanup);

describe("Empty", () => {
  it("renders a title, an explanation and a next-step action", () => {
    render(
      <Empty title="No plans yet" action={<a href="/merchant">Publish a plan</a>}>
        Nothing has been published yet.
      </Empty>,
    );
    expect(screen.getByText("No plans yet")).toBeTruthy();
    expect(screen.getByText(/Nothing has been published yet\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Publish a plan" }).getAttribute("href")).toBe(
      "/merchant",
    );
  });

  it("still renders a bare explanation for transitional states", () => {
    render(<Empty>Loading history…</Empty>);
    expect(screen.getByText("Loading history…")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("SubscribePage empty states", () => {
  it("offers to publish when the deployment has no plans at all (contract-only)", async () => {
    render(<SubscribePage />);

    expect(await screen.findByText("No plans yet")).toBeTruthy();
    const action = screen.getByRole("link", { name: "Publish a plan" });
    expect(action.getAttribute("href")).toBe("/merchant");
    // The list came from the contract fallback, not the indexer.
    expect(chainMock.chainPlans).toHaveBeenCalled();
  });

  it("says plans are deactivated, not missing, when every plan is inactive", async () => {
    apiMock.plans.mockResolvedValue({ plans: [plan({ active: 0 })] });

    render(<SubscribePage />);

    expect(await screen.findByText("No active plans right now")).toBeTruthy();
    expect(screen.queryByText("No plans yet")).toBeNull();
    // The next action is the same either way.
    expect(screen.getByRole("link", { name: "Publish a plan" }).getAttribute("href")).toBe(
      "/merchant",
    );
  });
});

describe("AccountPage empty states", () => {
  it("offers a connect button instead of a dead end for a wallet-less visitor", () => {
    render(<AccountPage />);

    expect(screen.getByText("No wallet connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(wallet.connect).toHaveBeenCalled();
  });

  it("explains contract-only history instead of claiming there were no events", async () => {
    wallet.address = SUBSCRIBER;

    render(<AccountPage />);

    expect(await screen.findByText(/not available in contract-only mode/i)).toBeTruthy();
    expect(screen.queryByText("No vault activity yet")).toBeNull();
  });

  it("offers a deposit when the indexer says the vault has no activity yet", async () => {
    wallet.address = SUBSCRIBER;
    apiMock.vaultHistory.mockResolvedValue({ events: [] });

    render(<AccountPage />);

    expect(await screen.findByText("No vault activity yet")).toBeTruthy();
    // The anchor jumps to the deposit field rendered above on the same page.
    expect(screen.getByRole("link", { name: "Make a deposit" }).getAttribute("href")).toBe(
      "#amount",
    );
  });

  it("points a subscriber with no mandates at the plans page", async () => {
    wallet.address = SUBSCRIBER;

    render(<AccountPage />);

    expect(await screen.findByText("No subscriptions yet")).toBeTruthy();
    const action = screen.getByRole("link", { name: "Browse plans" });
    expect(action.getAttribute("href")).toBe("/subscribe");
    // Mandates came from the contract fallback, not the indexer.
    expect(chainMock.chainMandatesOf).toHaveBeenCalledWith(SUBSCRIBER, SUBSCRIBER);
  });
});

describe("MerchantPage empty states", () => {
  it("offers a connect button instead of a dead end for a wallet-less visitor", () => {
    render(<MerchantPage />);

    expect(screen.getByText("No wallet connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(wallet.connect).toHaveBeenCalled();
  });

  it("points an empty dashboard at the publish form and the public page", async () => {
    wallet.address = MERCHANT;

    render(<MerchantPage />);

    expect(await screen.findByText("No plans yet")).toBeTruthy();
    // The anchor jumps to the publish form rendered above on the same page.
    expect(
      screen.getByRole("link", { name: "Publish a plan" }).getAttribute("href"),
    ).toBe("#publish-plan");

    expect(screen.getByText("No subscribers yet")).toBeTruthy();
    // The public catalogue link is the way to get that first subscriber.
    const publicLink = screen.getByRole("link", { name: "Open your public page" });
    expect(publicLink.getAttribute("href")).toContain(`/m/?address=${MERCHANT}`);
  });

  it("explains that historical churn needs the backend when no API URL is configured", async () => {
    wallet.address = MERCHANT;

    render(<MerchantPage />);

    expect(
      await screen.findByText(/Historical churn analytics require the payflow backend/),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Monthly subscriber activity" })).toBeNull();
    expect(apiMock.merchantChurn).not.toHaveBeenCalled();
  });
});
