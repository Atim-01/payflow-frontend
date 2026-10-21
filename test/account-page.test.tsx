// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AccountPage from "@/app/account/page";
import type { ApiMandate } from "@/lib/api";
import { formatDate } from "@/i18n/format";
import { minPauseDate } from "@/lib/format";

/**
 * The account page is the first page rendered in tests because it exercises
 * all three data paths the issue calls out: a wallet-less visitor, the indexer,
 * and the contract-only fallback used by the public demo. The wallet is mocked
 * so the test never touches Stellar Wallets Kit or the network.
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
  charges: vi.fn(),
  stream: vi.fn(),
}));

const payflowMock = vi.hoisted(() => ({
  vaultBalance: vi.fn(),
  deposit: vi.fn(),
  withdraw: vi.fn(),
  depositFor: vi.fn(),
  setPaused: vi.fn(),
  pauseUntil: vi.fn(),
  cancel: vi.fn(),
  readContract: vi.fn(),
  server: { getTransaction: vi.fn() },
}));

const payflowHelpers = vi.hoisted(() => ({
  mandatePauseUntil: vi.fn(),
  mandateIsPastDue: vi.fn(() => false),
  mandatePastDueUntil: vi.fn(() => null),
  vaultSupportsDepositFor: vi.fn(),
  validateRecipient: vi.fn(),
}));

const chainMock = vi.hoisted(() => ({
  chainMandatesOf: vi.fn(),
}));

vi.mock("@/lib/wallet", () => ({ useWallet: () => wallet }));

vi.mock("@/lib/api", () => ({
  api: {
    isConfigured: apiMock.isConfigured,
    mandatesOf: apiMock.mandatesOf,
    vaultHistory: apiMock.vaultHistory,
    charges: apiMock.charges,
    stream: apiMock.stream,
  },
  checkWebhookUrl: vi.fn(),
}));
vi.mock("@/lib/payflow", () => ({
  payflow: payflowMock,
  readContract: payflowMock.readContract,
  server: payflowMock.server,
  ...payflowHelpers,
  mandateSupportsSpendLimit: vi.fn(() => false),
  // `lib/chain` imports these at module scope; the partial chain mock below
  // loads the real module for its pure vault helpers.
  MAX_PAGE: 50,
  mandateStatus: (raw: unknown) =>
    Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? ""),
}));
// Partial mock: the export tests make the vault-history request succeed, and
// the page uses the real pure helpers for the event list. Only the contract
// fallback is replaced.
vi.mock("@/lib/chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chain")>();
  return { ...actual, chainMandatesOf: chainMock.chainMandatesOf };
});
// Merchant names come from Horizon + stellar.toml; the page must render
// without either, so the resolver is pinned to "no name published".
vi.mock("@/lib/toml", () => ({ useOrgName: () => null }));

// Pinned so the page has a token contract to ask about. Without it the token
// id is "" in tests and every amount falls back to native XLM.
vi.mock("@/lib/config", () => ({
  config: {
    rpcUrl: "http://localhost:8000/rpc",
    networkPassphrase: "Test SDF Network ; September 2015",
    network: "TESTNET",
    apiUrl: "http://localhost:8080",
    readSource: "GAP6QFLXQD73URCC3EXU2WOQHIAREPCGMSIMKF5PFLLI5TR6HTMNDTIE",
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

const SUBSCRIBER = "GAP6QFLXQD73URCC3EXU2WOQHIAREPCGMSIMKF5PFLLI5TR6HTMNDTIE";
const MERCHANT = "GCH5VHWNS24VI75HLDBHK4SSJ2E5XZA5IB6XEZTNE4BJH7AKZI6Z3MHU";
// Another account label for the switch test. Literal 56-character Stellar
// identifiers in added lines are reported as leaked secrets by the repo scan.
const OTHER = "other-account.testnet";
const USDC = "token-contract.testnet";

// Captured from the anchor `downloadCsv` synthesises, so the tests assert the
// actual filename and file body rather than only that a click happened.
const downloads: { name: string; blob: Blob }[] = [];
let lastBlob: Blob | null = null;

function mandate(overrides: Partial<ApiMandate> = {}): ApiMandate {
  return {
    id: 7,
    subscriber: SUBSCRIBER,
    merchant: MERCHANT,
    plan_id: 1,
    amount: "10000000", // 1 XLM
    period: 2_592_000, // monthly
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
  wallet.connecting = false;
  wallet.error = null;
  wallet.networkMismatch = false;
  wallet.walletNetwork = null;
  apiMock.mandatesOf.mockReset();
  apiMock.vaultHistory.mockReset();
  apiMock.charges.mockReset();
  payflowMock.server.getTransaction.mockReset();
  payflowMock.vaultBalance.mockReset();
  payflowMock.deposit.mockReset();
  payflowMock.withdraw.mockReset();
  payflowMock.setPaused.mockReset();
  payflowMock.pauseUntil.mockReset();
  // Default: the deployed contract has no pause_until, so the picker is hidden.
  payflowHelpers.mandatePauseUntil.mockReset();
  payflowHelpers.mandatePauseUntil.mockReturnValue(null);
  // Default: the deployed contract has no deposit_for, so the sponsor panel is hidden.
  payflowHelpers.vaultSupportsDepositFor.mockReset();
  payflowHelpers.vaultSupportsDepositFor.mockResolvedValue(false);
  payflowHelpers.validateRecipient.mockReset();
  payflowMock.cancel.mockReset();
  payflowMock.deposit.mockReset();
  payflowMock.depositFor.mockReset();
  payflowMock.withdraw.mockReset();
  payflowMock.setPaused.mockReset();
  payflowMock.pauseUntil.mockReset();
  payflowMock.readContract.mockReset();
  chainMock.chainMandatesOf.mockReset();
  // The token metadata cache is module-level and outlives a single render.
  const { clearTokenMetaCache } = await import("@/lib/token");
  clearTokenMetaCache();

  downloads.length = 0;
  lastBlob = null;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn((blob: Blob) => {
      lastBlob = blob;
      return "blob:test";
    }),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push({ name: this.download, blob: lastBlob! });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AccountPage", () => {
  it("asks for a wallet when none is connected", () => {
    wallet.address = null;
    render(<AccountPage />);

    expect(
      screen.getByText(/connect a wallet to see your vault balance/i),
    ).toBeTruthy();
    expect(apiMock.mandatesOf).not.toHaveBeenCalled();
  });

  it("renders the vault balance and mandates served by the indexer", async () => {
    payflowMock.vaultBalance.mockResolvedValue(50_000_000n);
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate()] });

    render(<AccountPage />);

    // 50_000_000 stroops renders as 5 XLM, not 50000000.
    expect(await screen.findByText("5 XLM")).toBeTruthy();
    expect(screen.getByText("Mandate #7")).toBeTruthy();
    expect(screen.getByText(/1 XLM per month/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Cancel subscription #7" }),
    ).toBeTruthy();
    expect(screen.getByText("Active subscriptions").parentElement?.textContent).toContain(
      "1",
    );
    expect(payflowMock.vaultBalance).toHaveBeenCalledWith(
      SUBSCRIBER,
      SUBSCRIBER,
      expect.any(String),
    );
    expect(chainMock.chainMandatesOf).not.toHaveBeenCalled();
  });

  it("falls back to contract state when the indexer is unavailable", async () => {
    // The public demo runs without a backend; api methods return null rather
    // than throwing, and the page must still list the subscriber's mandates.
    payflowMock.vaultBalance.mockResolvedValue(0n);
    apiMock.mandatesOf.mockResolvedValue(null);
    chainMock.chainMandatesOf.mockResolvedValue([
      mandate({ id: 9, status: "Cancelled" }),
    ]);

    render(<AccountPage />);

    expect(await screen.findByText("Mandate #9")).toBeTruthy();
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(chainMock.chainMandatesOf).toHaveBeenCalledWith(SUBSCRIBER, SUBSCRIBER);
    // Cancelled mandates are terminal, so the page must not offer Cancel.
    expect(screen.queryByRole("button", { name: /^Cancel subscription/ })).toBeNull();
  });

  it("disables write actions while the wallet is on the wrong network", async () => {
    wallet.networkMismatch = true;
    payflowMock.vaultBalance.mockResolvedValue(0n);
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate()] });

    render(<AccountPage />);

    const deposit = (await screen.findByRole("button", {
      name: "Deposit",
    })) as HTMLButtonElement;
    const withdraw = screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement;
    const pause = (await screen.findByRole("button", {
      name: "Pause",
    })) as HTMLButtonElement;

    expect(deposit.disabled).toBe(true);
    expect(withdraw.disabled).toBe(true);
    expect(pause.disabled).toBe(true);
  });

  it("labels and scales amounts with the token's own metadata", async () => {
    // A 6-decimal token: 50_000_000 smallest units is 50, not 5. Reading it as
    // XLM is the bug this page used to have.
    payflowMock.readContract.mockImplementation(async (_id: string, method: string) =>
      method === "symbol" ? "USDC" : 6,
    );
    payflowMock.vaultBalance.mockResolvedValue(50_000_000n);
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate()] });

    render(<AccountPage />);

    expect(await screen.findByText("50 USDC")).toBeTruthy();
    expect(await screen.findByText(/10 USDC per month/)).toBeTruthy();
    expect(screen.getByLabelText("Amount (USDC)")).toBeTruthy();
    expect(payflowMock.readContract).toHaveBeenCalledWith(
      expect.any(String),
      "decimals",
      expect.any(String),
    );
  });

  it("still shows amounts when the token's metadata cannot be read", async () => {
    payflowMock.readContract.mockRejectedValue(new Error("host error: missing contract"));
    payflowMock.vaultBalance.mockResolvedValue(50_000_000n);
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate()] });

    render(<AccountPage />);

    // Degrades to the native assumption rather than blanking the page.
    expect(await screen.findByText("5 XLM")).toBeTruthy();
  });

  it("asks for confirmation before cancelling a subscription", async () => {
    payflowMock.vaultBalance.mockResolvedValue(0n);
    payflowMock.cancel.mockResolvedValue("c0ffee");
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate()] });

    render(<AccountPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel subscription #7" }),
    );

    // The irreversible write has not happened yet.
    expect(payflowMock.cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Keep" })).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Confirm cancelling subscription #7",
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(payflowMock.cancel).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Cancel subscription #7" }),
    ).toBeTruthy();
  });

  it("only sends the cancel transaction from Confirm", async () => {
    payflowMock.vaultBalance.mockResolvedValue(0n);
    payflowMock.cancel.mockResolvedValue("c0ffee");
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate()] });

    render(<AccountPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel subscription #7" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm cancelling subscription #7",
      }),
    );

    await waitFor(() =>
      expect(payflowMock.cancel).toHaveBeenCalledWith(
        SUBSCRIBER,
        expect.any(Function),
        7,
      ),
    );
    expect(payflowMock.cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps only one mandate in the confirming state at a time", async () => {
    payflowMock.vaultBalance.mockResolvedValue(0n);
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ id: 7 }), mandate({ id: 8 })],
    });

    render(<AccountPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel subscription #7" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel subscription #8" }));

    expect(screen.getAllByRole("button", { name: "Keep" })).toHaveLength(1);
    expect(
      screen.getByRole("button", {
        name: "Confirm cancelling subscription #8",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Confirm cancelling subscription #7",
      }),
    ).toBeNull();
  });

  it("renders the next six charges and their running total", async () => {
    payflowMock.vaultBalance.mockResolvedValue(100_000_000n); // 10 XLM
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ next_charge: 1_700_000_000, period: 2_592_000 })],
    });

    render(<AccountPage />);

    const timeline = await screen.findByRole("region", {
      name: "Upcoming charges",
    });
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(6);
    expect(within(timeline).getByText(/Next 6 total/).textContent).toContain(
      "6 XLM",
    );
    expect(within(timeline).getByText(/Running total/).textContent).toContain(
      "6 XLM",
    );
  });

  it("renders the timeline from contract state when the indexer is offline", async () => {
    payflowMock.vaultBalance.mockResolvedValue(100_000_000n);
    apiMock.mandatesOf.mockResolvedValue(null);
    chainMock.chainMandatesOf.mockResolvedValue([
      mandate({ next_charge: 1_700_000_000, period: 2_592_000 }),
    ]);

    render(<AccountPage />);

    const timeline = await screen.findByRole("region", {
      name: "Upcoming charges",
    });
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(6);
    expect(chainMock.chainMandatesOf).toHaveBeenCalledWith(SUBSCRIBER, SUBSCRIBER);
  });

  it("does not render a timeline for paused mandates", async () => {
    payflowMock.vaultBalance.mockResolvedValue(100_000_000n);
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [
        mandate({
          status: "Paused",
          next_charge: 1_700_000_000,
          period: 2_592_000,
        }),
      ],
    });

    render(<AccountPage />);

    await screen.findByText("Mandate #7");
    expect(screen.queryByRole("region", { name: "Upcoming charges" })).toBeNull();
  });

  it("warns when the vault cannot cover the next charge", async () => {
    payflowMock.vaultBalance.mockResolvedValue(0n);
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ next_charge: 1_700_000_000, period: 2_592_000 })],
    });

    render(<AccountPage />);

    const timeline = await screen.findByRole("region", {
      name: "Upcoming charges",
    });
    const warning = within(timeline).getByRole("status");
    expect(warning.textContent).toContain("Your vault is short by 1 XLM");
  });
});

describe("AccountPage pause until", () => {
  const DAY_MS = 86_400_000;
  const inDays = (n: number) => Math.floor((Date.now() + n * DAY_MS) / 1000);

  beforeEach(() => {
    payflowMock.vaultBalance.mockResolvedValue(0n);
    apiMock.mandatesOf.mockResolvedValue({ mandates: [] });
  });

  it("hides the picker when the contract has no pause_until", async () => {
    // A contract built before payflow-contract#41 decodes mandates without it.
    payflowHelpers.mandatePauseUntil.mockReturnValue(null);
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate({ status: "Active" })] });

    render(<AccountPage />);
    await screen.findByText("Mandate #7");

    expect(screen.queryByRole("button", { name: "Pause until…" })).toBeNull();
    // The existing pause toggle is untouched.
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("offers a date picker once the contract carries pause_until", async () => {
    payflowHelpers.mandatePauseUntil.mockReturnValue(inDays(3));
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate({ status: "Active" })] });

    render(<AccountPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause until…" }));

    const input = screen.getByLabelText(/Resume date for mandate 7/) as HTMLInputElement;
    expect(input.type).toBe("date");
    // Today is not offered: resuming at midnight tonight has already passed.
    expect(input.min).toBe(minPauseDate());
  });

  it("sends the chosen date as a Unix time", async () => {
    payflowHelpers.mandatePauseUntil.mockReturnValue(inDays(3));
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate({ status: "Active" })] });
    payflowMock.pauseUntil.mockResolvedValue("cafe");

    render(<AccountPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause until…" }));

    const chosen = "2027-03-14";
    fireEvent.change(screen.getByLabelText(/Resume date for mandate 7/), {
      target: { value: chosen },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pause until…" }));

    await waitFor(() =>
      expect(payflowMock.pauseUntil).toHaveBeenCalledWith(
        SUBSCRIBER,
        expect.any(Function),
        7,
        Date.UTC(2027, 2, 14) / 1000,
      ),
    );
  });

  it("refuses a date in the past instead of sending it", async () => {
    payflowHelpers.mandatePauseUntil.mockReturnValue(inDays(3));
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate({ status: "Active" })] });

    render(<AccountPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause until…" }));
    fireEvent.change(screen.getByLabelText(/Resume date for mandate 7/), {
      target: { value: "2020-01-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pause until…" }));

    expect(await screen.findByText("Pick a date in the future.")).toBeTruthy();
    expect(payflowMock.pauseUntil).not.toHaveBeenCalled();
  });

  it("refuses an empty date instead of sending it", async () => {
    payflowHelpers.mandatePauseUntil.mockReturnValue(inDays(3));
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate({ status: "Active" })] });

    render(<AccountPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause until…" }));
    fireEvent.change(screen.getByLabelText(/Resume date for mandate 7/), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pause until…" }));

    expect(await screen.findByText(/Pick a date for the mandate to resume on/)).toBeTruthy();
    expect(payflowMock.pauseUntil).not.toHaveBeenCalled();
  });

  it("shows the resume date on a paused mandate", async () => {
    const until = inDays(3);
    payflowHelpers.mandatePauseUntil.mockReturnValue(until);
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ status: "Paused", pause_until: until })],
    });

    render(<AccountPage />);

    expect(await screen.findByText(`resumes ${formatDate(until, "en")}`)).toBeTruthy();
  });

  it("shows no resume date once it has passed", async () => {
    payflowHelpers.mandatePauseUntil.mockReturnValue(inDays(-1));
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ status: "Active", pause_until: inDays(-1) })],
    });

    render(<AccountPage />);
    await screen.findByText("Mandate #7");

    expect(screen.queryByText(/resumes /)).toBeNull();
  });

  it("does not offer a picker on a cancelled mandate", async () => {
    payflowHelpers.mandatePauseUntil.mockReturnValue(inDays(3));
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ status: "Cancelled" })],
    });

    render(<AccountPage />);
    await screen.findByText("Cancelled");

    expect(screen.queryByRole("button", { name: "Pause until…" })).toBeNull();
  });

  it("disables the picker while the wallet is on the wrong network", async () => {
    wallet.networkMismatch = true;
    payflowHelpers.mandatePauseUntil.mockReturnValue(inDays(3));
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate({ status: "Active" })] });

    render(<AccountPage />);
    const picker = (await screen.findByRole("button", { name: "Pause until…" })) as HTMLButtonElement;

    expect(picker.disabled).toBe(true);
  });

  it("works in contract-only mode when chain state carries the field", async () => {
    // The public demo has no indexer. The mandates come from the contract, so
    // the capability signal and the resume date must survive that path too.
    apiMock.mandatesOf.mockResolvedValue(null);
    chainMock.chainMandatesOf.mockResolvedValue([
      mandate({ status: "Paused", pause_until: inDays(3) }),
    ]);
    payflowHelpers.mandatePauseUntil.mockImplementation(
      (m: { pause_until?: number } | null) => m?.pause_until ?? null,
    );

    render(<AccountPage />);

    expect(await screen.findByRole("button", { name: "Pause until…" })).toBeTruthy();
    expect(chainMock.chainMandatesOf).toHaveBeenCalledWith(SUBSCRIBER, SUBSCRIBER);
  });

  it("exports payments across mandates in each token's own decimals", async () => {
    payflowMock.vaultBalance.mockResolvedValue(0n);
    payflowMock.readContract.mockImplementation(async (_id: string, method: string) =>
      method === "symbol" ? "USDC" : 6,
    );
    payflowMock.server.getTransaction.mockResolvedValue({ createdAt: 1767225600 });
    apiMock.vaultHistory.mockResolvedValue({ events: [] });
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [
        mandate({ id: 7, token: USDC }),
        mandate({ id: 8, token: USDC, merchant: SUBSCRIBER }),
      ],
    });
    apiMock.charges.mockImplementation(async (id: number) => ({
      charges:
        id === 7
          ? [
              {
                tx_hash: "aa11",
                mandate_id: 7,
                amount: "50000000", // 50 USDC at 6 decimals
                fee: "500000", // 0.5 USDC
                charges_made: 1,
                ledger: 100,
              },
            ]
          : [
              {
                tx_hash: "bb22",
                mandate_id: 8,
                amount: "2500000", // 2.5 USDC
                fee: "25000", // 0.025 USDC
                charges_made: 1,
                ledger: 200,
              },
            ],
    }));

    render(<AccountPage />);

    const button = (await screen.findByRole("button", {
      name: "Export my payments as CSV",
    })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() => expect(downloads).toHaveLength(1));
    // Filename carries the account and the charge date, so two exports do not
    // silently overwrite each other.
    expect(downloads[0]!.name).toBe(
      `payflow-payments-${SUBSCRIBER}-2026-01-01_to_2026-01-01.csv`,
    );

    const text = await downloads[0]!.blob.text();
    const lines = text.split("\n");
    expect(lines[0]).toBe(
      "date,mandate id,merchant,amount,fee,net,token,token contract,tx hash,ledger",
    );
    // 50 USDC, not 5: the export uses the token's 6 decimals, and net is
    // computed in bigint from the same smallest-unit amounts.
    expect(lines[1]).toBe(
      `2026-01-01,8,${SUBSCRIBER},2.5,0.025,2.475,USDC,${USDC},bb22,200`,
    );
    expect(lines[2]).toBe(
      `2026-01-01,7,${MERCHANT},50,0.5,49.5,USDC,${USDC},aa11,100`,
    );
    expect(apiMock.charges).toHaveBeenCalledWith(7);
    expect(apiMock.charges).toHaveBeenCalledWith(8);
    expect(screen.getByText("Exported 2 payments to CSV.")).toBeTruthy();
  });

  it("can still export while the wallet is on another network", async () => {
    // Exporting is a read of the indexer and a local file write; it signs
    // nothing, so a mismatched network must not hide a subscriber's records.
    wallet.networkMismatch = true;
    payflowMock.vaultBalance.mockResolvedValue(0n);
    apiMock.vaultHistory.mockResolvedValue({ events: [] });
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate()] });

    render(<AccountPage />);

    const button = (await screen.findByRole("button", {
      name: "Export my payments as CSV",
    })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it("refuses a partial export when one mandate's history cannot be read", async () => {
    payflowMock.vaultBalance.mockResolvedValue(0n);
    payflowMock.readContract.mockImplementation(async (_id: string, method: string) =>
      method === "symbol" ? "USDC" : 6,
    );
    apiMock.vaultHistory.mockResolvedValue({ events: [] });
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ id: 7, token: USDC }), mandate({ id: 8, token: USDC })],
    });
    apiMock.charges.mockImplementation(async (id: number) =>
      id === 7
        ? {
            charges: [
              {
                tx_hash: "aa11",
                mandate_id: 7,
                amount: "1000000",
                fee: "10000",
                charges_made: 1,
                ledger: 100,
              },
            ],
          }
        : null,
    );

    render(<AccountPage />);

    const button = (await screen.findByRole("button", {
      name: "Export my payments as CSV",
    })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);

    // A file missing one subscription would understate spending while looking
    // complete, so nothing is written at all.
    expect(await screen.findByText(/Could not read payment history for mandate #8/)).toBeTruthy();
    expect(downloads).toHaveLength(0);
  });

  it("explains why the export cannot run in contract-only mode", async () => {
    payflowMock.vaultBalance.mockResolvedValue(0n);
    apiMock.mandatesOf.mockResolvedValue(null);
    apiMock.vaultHistory.mockResolvedValue(null);
    chainMock.chainMandatesOf.mockResolvedValue([mandate()]);

    render(<AccountPage />);

    const button = (await screen.findByRole("button", {
      name: "Export my payments as CSV",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/and this CSV export/)).toBeTruthy();
    expect(screen.getByText(/Set\s+NEXT_PUBLIC_API_URL/)).toBeTruthy();
    expect(apiMock.charges).not.toHaveBeenCalled();
  });

  it("says there is nothing to export instead of downloading an empty file", async () => {
    payflowMock.vaultBalance.mockResolvedValue(0n);
    payflowMock.readContract.mockImplementation(async (_id: string, method: string) =>
      method === "symbol" ? "USDC" : 6,
    );
    apiMock.vaultHistory.mockResolvedValue({ events: [] });
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate({ token: USDC })] });
    apiMock.charges.mockResolvedValue({ charges: [] });

    render(<AccountPage />);

    const button = (await screen.findByRole("button", {
      name: "Export my payments as CSV",
    })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);

    expect(await screen.findByText(/No payments to export yet/)).toBeTruthy();
    expect(downloads).toHaveLength(0);
  });

  it("discards a load that finishes after the wallet switched accounts", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    const first = new Promise<unknown>((resolve) => {
      resolveFirst = resolve;
    });
    payflowMock.vaultBalance.mockResolvedValue(0n);
    apiMock.vaultHistory.mockResolvedValue({ events: [] });
    apiMock.mandatesOf.mockImplementation((subscriber: string) =>
      subscriber === SUBSCRIBER
        ? first
        : Promise.resolve({ mandates: [mandate({ id: 99, subscriber: OTHER })] }),
    );

    const { rerender } = render(<AccountPage />);

    // The second account's load starts before the first one's reads resolve.
    wallet.address = OTHER;
    rerender(<AccountPage />);
    expect(await screen.findByText("Mandate #99")).toBeTruthy();

    await act(async () => {
      resolveFirst({ mandates: [mandate({ id: 7 })] });
    });

    // The stale result must not replace the new account's mandates.
    expect(screen.queryByText("Mandate #7")).toBeNull();
    expect(screen.getByText("Mandate #99")).toBeTruthy();
  });
});

describe("AccountPage charge reminders (#174)", () => {
  it("never asks for notification permission on page load", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    class FakeNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = requestPermission;
    }
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      writable: true,
      value: FakeNotification,
    });
    payflowMock.vaultBalance.mockResolvedValue(0n);
    apiMock.vaultHistory.mockResolvedValue({ events: [] });
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ next_charge: Math.floor(Date.now() / 1000) + 86_400 })],
    });

    render(<AccountPage />);
    await screen.findByText("Mandate #7");

    expect(requestPermission).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remind me" })).toBeTruthy();
  });

  it("asks only on the opt-in click and stores the preference per address", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    class FakeNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = requestPermission;
    }
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      writable: true,
      value: FakeNotification,
    });
    window.localStorage.clear();
    payflowMock.vaultBalance.mockResolvedValue(0n);
    apiMock.vaultHistory.mockResolvedValue({ events: [] });
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ next_charge: Math.floor(Date.now() / 1000) + 86_400 })],
    });

    render(<AccountPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Remind me" }));

    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Reminder on" })).toBeTruthy();
    expect(
      JSON.parse(window.localStorage.getItem(`payflow.reminders.${SUBSCRIBER}`) ?? "{}"),
    ).toEqual({ "7": true });
  });

  it("does not offer a reminder on an ended mandate", async () => {
    payflowMock.vaultBalance.mockResolvedValue(0n);
    apiMock.vaultHistory.mockResolvedValue({ events: [] });
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate({ status: "Cancelled" })] });

    render(<AccountPage />);
    await screen.findByText("Mandate #7");

    expect(screen.queryByRole("button", { name: "Remind me" })).toBeNull();
  });
});
