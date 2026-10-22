"use client";

import { useI18n } from "@/i18n/provider";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { StrKey } from "@stellar/stellar-sdk";
import { api, type ApiMandate, type ApiVaultEvent, type StreamEvent } from "@/lib/api";
import { buildUpcomingChargesCalendar, CALENDAR_FILENAME } from "@/lib/calendar";
import {
  buildPaymentsCsv,
  downloadCsv,
  paymentsFilename,
  type PaymentRow,
} from "@/lib/csv";
import {
  chainMandatesOf,
  sortVaultEventsNewestFirst,
  vaultEventAmount,
  vaultEventLabel,
  vaultEventTone,
} from "@/lib/chain";
import { config, type ConfiguredToken } from "@/lib/config";

const DEFAULT_TOKENS: readonly ConfiguredToken[] = [
  {
    id: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    symbol: "XLM",
    name: "Stellar Lumens",
    decimals: 7,
  },
  {
    id: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    classicAsset: {
      code: "USDC",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    },
  },
];
import { nextChargeAmount, remainingDiscountCharges } from "@/lib/discount";
import {
  mandateIsPastDue,
  mandatePastDueUntil,
  mandatePauseUntil,
  mandateSupportsSpendLimit,
  payflow,
  server,
  vaultSupportsDepositFor,
  validateRecipient,
} from "@/lib/payflow";
import { mandateStatus } from "@/lib/mandate-status";
import { createdAtDate, paymentDateRange, paymentRow, sortPaymentsNewestFirst } from "@/lib/payments";
import { useWallet } from "@/lib/wallet";
import { useStream } from "@/lib/stream";
import {
  addReminder,
  buildReminderSchedule,
  hasReminder,
  pruneEndedReminders,
  readReminderPrefs,
  reminderEligible,
  removeReminder,
  saveReminderPrefs,
  type ReminderPrefs,
  type ScheduledReminder,
} from "@/lib/reminders";
import{ fromStroops, minPauseDate, parsePauseDate, resumeDate, shortAddress } from "@/lib/format";
import { buildChargeSchedule, chargeShortfall } from "@/lib/schedule";
import { computeVaultRunway } from "@/lib/runway";

import { loadTokenMeta, metaFor, useTokenMetas } from "@/lib/token";
import { VirtualList } from "@/components/VirtualList";
import { AmountInput } from "@/components/AmountInput";
import {
  Badge,
  Empty,
  MerchantAccount,
  Notice,
  Panel,
  SkeletonRows,
  Stat,
  TimeAgo,
  TxLink,
} from "@/components/ui";

function AccountInner() {
  const { checkAmount, t: tr, formatDate, parseAmount, formatAmount, formatPeriod, translateMessage, describeTrialEnd, discountBadge, formatTokenValue, formatNumber } = useI18n();
  const searchParams = useSearchParams();
  const paramAddress = searchParams?.get("address");
  const targetAddress =
    paramAddress && StrKey.isValidEd25519PublicKey(paramAddress.trim())
      ? paramAddress.trim()
      : null;

  const { address, networkMismatch, signXdr, connect, connecting } = useWallet();

  // The account whose data is displayed on screen
  const viewAddress = targetAddress ?? address;
  // Read-only mode applies if an address parameter was supplied and either no wallet
  // is connected or the connected wallet's address differs from the target.
  const isReadOnly = Boolean(targetAddress && (!address || address !== targetAddress));

  const [balance, setBalance] = useState<bigint | null>(null);
  const [mandates, setMandates] = useState<ApiMandate[] | null>(null);
  const [history, setHistory] = useState<ApiVaultEvent[] | null>(null);
  const [indexerAvailable, setIndexerAvailable] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // Cancelling is permanent, so the first click only reveals Keep/Confirm.
  const [confirmCancel, setConfirmCancel] = useState<number | null>(null);
  // The mandate whose date picker is open, and the date typed into it.
  const [pauseFor, setPauseFor] = useState<number | null>(null);
  const [pauseDate, setPauseDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // Whether the mandate list came from the indexer. Payment history lives only
  // there, so this is what gates the CSV export.
  const [mandatesFromApi, setMandatesFromApi] = useState(false);
  // Whether the deployed vault contract supports depositing into another
  // account's vault (payflow-contract#29). null while the probe is in flight.
  const [fundSupport, setFundSupport] = useState<boolean | null>(null);
  const [fundRecipient, setFundRecipient] = useState("");
  const [fundAmount, setFundAmount] = useState("");
  // The recipient awaiting a second-click confirmation — one at a time.
  const [fundFor, setFundFor] = useState<string | null>(null);

  // Track who paused each mandate: "subscriber" | "merchant" | undefined
  // Updated by the SSE stream when available.
  const [pausedBy, setPausedBy] = useState<Map<number, "subscriber" | "merchant">>(new Map());
  const [missingTrustlines, setMissingTrustlines] = useState<ConfiguredToken[]>([]);
  // Reminder preferences are per connected address. Loading them never asks
  // for notification permission; only the "Remind me" click can do that.
  const [reminderPrefs, setReminderPrefs] = useState<ReminderPrefs>({});
  const [reminderBusy, setReminderBusy] = useState<number | null>(null);
  // Notifications already shown for a particular charge, so a reload or a
  // data refresh does not repeat one the subscriber has seen.
  const shownReminders = useRef<Set<string>>(new Set());

  const configuredTokens: readonly ConfiguredToken[] =
    (config as unknown as { tokens?: ConfiguredToken[] }).tokens ?? DEFAULT_TOKENS;

  // Read inside async callbacks to detect a wallet account switch mid-load:
  // the closure's `who` is the account the request started for, which may
  // no longer be the account whose page is on screen.
  const addressRef = useRef<string | null>(viewAddress);
  // The guard is kept current in an effect rather than during render
  // (react-hooks/refs). Reads happen in async callbacks; the effect flushes
  // long before any wallet prompt resolves, so a switch mid-load is still
  // caught.
  useEffect(() => {
    addressRef.current = viewAddress;
  }, [viewAddress]);

  // The vault holds the configured token; each mandate carries the token it
  // was opened against, which the indexer does not report.
  const metas = useTokenMetas([
    config.contracts.token,
    ...configuredTokens.map((t) => t.id),
    ...(mandates ?? []).map((m) => m.token ?? config.contracts.token),
  ]);
  const vaultMeta = metaFor(metas, config.contracts.token);

  /** Whether the recipient address and amount are right to submit right now. */
  const recipientDisplayError = fundRecipient.trim()
    ? validateRecipient(fundRecipient)
    : null;
  const fundAmountCheck = checkAmount(fundAmount, vaultMeta.decimals);
  const fundStroops = fundAmountCheck.ok ? fundAmountCheck.stroops : 0n;

  // Source account for simulation
  const source = address ?? config.readSource;
  const load = useCallback(async () => {
    addressRef.current = viewAddress;
    if (!viewAddress) return;
    const who = viewAddress;
    const [bal, res, hist] = await Promise.allSettled([
      payflow.vaultBalance(source, who, config.contracts.token),
      api.mandatesOf(who),
      api.vaultHistory(who),
    ]);
    // The wallet may have switched accounts while those reads were in flight.
    // Applying them would show one account's balance under another's address.
    if (addressRef.current !== who) return;
    if (bal.status === "fulfilled") setBalance(bal.value);

    if (res.status === "fulfilled" && res.value) {
      setMandates(res.value.mandates);
      setMandatesFromApi(true);
    } else {
      // No indexer: read the subscriber's mandates from the contract.
      try {
        const fromChain = await chainMandatesOf(source, who);
        if (addressRef.current !== who) return;
        setMandates(fromChain);
      } catch {
        if (addressRef.current !== who) return;
        setMandates([]);
      }
      setMandatesFromApi(false);
    }

    // A contract fallback above may have awaited long enough for an account
    // switch; do not attach the old account's history to the new one.
    if (addressRef.current !== who) return;

    // Vault history lives only in the indexer; without a backend there is no
    // contract-side event log to fall back to, so we report what is knowable.
    if (hist.status === "fulfilled" && hist.value) {
      setHistory(sortVaultEventsNewestFirst(hist.value.events));
      setIndexerAvailable(true);
    } else {
      setHistory([]);
      setIndexerAvailable(false);
    }

    // Check classic asset trustlines for mandates in other tokens
    if (who && configuredTokens.length > 0 && typeof payflow.checkTrustline === "function") {
      const missing: ConfiguredToken[] = [];
      for (const tok of configuredTokens) {
        if (tok.classicAsset) {
          const hasTrust = await payflow.checkTrustline(
            who,
            tok.classicAsset.code,
            tok.classicAsset.issuer,
          );
          if (!hasTrust) {
            missing.push(tok);
          }
        }
      }
      if (addressRef.current === who) {
        setMissingTrustlines(missing);
      }
    }
  }, [viewAddress, source, configuredTokens]);

  // SSE stream for live updates (payflow-backend#19)
  useStream({
    address,
    role: "subscriber",
    onEvent: useCallback((event: StreamEvent) => {
      if (event.type === "mandate_pause") {
        setPausedBy((prev) => {
          const next = new Map(prev);
          next.set(event.mandate_id, event.by);
          return next;
        });
      }
      if (event.type === "mandate_status") {
        setPausedBy((prev) => {
          const next = new Map(prev);
          // If status becomes Active, the pause is over
          if (event.status === "Active") {
            next.delete(event.mandate_id);
          }
          return next;
        });
      }
      // For other events (charge, discount, end), trigger a reload
      // to get fresh data from the indexer
      if (event.type === "charge" || event.type === "mandate_discount" || event.type === "mandate_end") {
        void load();
      }
    }, [load]),
    enabled: api.isConfigured(),
  });

  useEffect(() => {
    // A different account means every previous value belongs to someone else:
    // clear them before the new reads start so no stale row or export survives
    // a wallet switch. Clearing here (rather than in `load`) keeps the refresh
    // after a transaction from flashing the page back to skeletons.
    setBalance(null);
    setMandates(null);
    setHistory(null);
    setIndexerAvailable(false);
    setMandatesFromApi(false);
    setInfo(null);
    setError(null);
    setDone(null);
    setExporting(false);
    void load();
  }, [load]);

  // A wallet switch mid-flow must not leave another account's mandate in the
  // confirming state.
  useEffect(() => {
    setConfirmCancel(null);
    setPauseFor(null);
    setFundFor(null);
    setReminderBusy(null);
  }, [address]);

  // Preferences belong to the connected subscriber, not the browser. Reading
  // them is silent: no permission prompt is allowed on page load.
  useEffect(() => {
    if (!address || typeof window === "undefined") {
      setReminderPrefs({});
      return;
    }
    setReminderPrefs(readReminderPrefs(window.localStorage, address));
  }, [address]);

  // A mandate that ended — cancelled here, by the merchant, or settled to its
  // charge cap — must stop reminding. `pruneEndedReminders` reads the status
  // through `mandateStatus`, so `["Cancelled"]` from contract state and
  // `"Cancelled"` from the indexer behave the same.
  useEffect(() => {
    if (!address || mandates === null || typeof window === "undefined") return;
    const pruned = pruneEndedReminders(reminderPrefs, mandates);
    if (pruned.removed.length === 0) return;
    setReminderPrefs(pruned.prefs);
    saveReminderPrefs(window.localStorage, address, pruned.prefs);
  }, [address, mandates, reminderPrefs]);

  /**
   * Deliver a reminder through the app's service worker when one is
   * installed, so clicking it opens the account page. A browser without a
   * service worker falls back to a page notification.
   */
  const showReminder = useCallback(async (reminder: ScheduledReminder) => {
    if (typeof window === "undefined") return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const options: NotificationOptions & { icon?: string } = {
      body: reminder.body,
      tag: reminder.tag,
      icon: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/icon-192.png`,
    };
    if ("serviceWorker" in navigator) {
      try {
        const registration = await navigator.serviceWorker.ready;
        if (registration && "showNotification" in registration) {
          await registration.showNotification(reminder.title, options);
          return;
        }
      } catch {
        // Fall through to the page notification below.
      }
    }
    new Notification(reminder.title, options);
  }, []);

  /**
   * Keep the service worker and this tab in step with the reminder set.
   *
   * Where the browser supports scheduled notifications (`TimestampTrigger`),
   * the installed PWA hands the schedule to the service worker and the page
   * sets no timer. Otherwise the page holds the timers for as long as it is
   * open — the limitation the panel text explains.
   */
  useEffect(() => {
    if (!address || typeof window === "undefined" || typeof navigator === "undefined") return;
    const schedule = buildReminderSchedule(mandates ?? [], reminderPrefs, Date.now());
    const payload = schedule.map((reminder) => ({
      id: reminder.mandateId,
      at: reminder.at,
      title: reminder.title,
      body: reminder.body,
      tag: reminder.tag,
    }));

    if ("serviceWorker" in navigator) {
      // Send an empty list when nothing is enabled, which also cancels timers
      // the worker was holding from a previous render.
      navigator.serviceWorker.ready
        .then((registration) => {
          registration.active?.postMessage({ type: "payflow-reminders-sync", reminders: payload });
        })
        .catch(() => {});
    }

    const triggerCtor = (window as unknown as { TimestampTrigger?: unknown }).TimestampTrigger;
    const backgroundScheduling = typeof triggerCtor === "function";
    if (backgroundScheduling) return;

    // `setTimeout` cannot wait longer than 2^31-1 ms (~24.8 days), and a
    // monthly reminder is about 29 days away. Walk to the target in chunks
    // instead of clamping, which would fire days early.
    const timers = schedule.map((reminder) => {
      const key = `${reminder.mandateId}:${reminder.nextCharge}`;
      if (shownReminders.current.has(key)) return () => {};
      let cancelled = false;
      let timer: number | null = null;
      const tick = () => {
        if (cancelled) return;
        const remaining = reminder.at - Date.now();
        if (remaining <= 0) {
          shownReminders.current.add(key);
          void showReminder(reminder);
          return;
        }
        timer = window.setTimeout(tick, Math.min(remaining, 2_147_483_647));
      };
      tick();
      return () => {
        cancelled = true;
        if (timer !== null) window.clearTimeout(timer);
      };
    });

    return () => {
      for (const cancel of timers) cancel();
    };
  }, [address, mandates, reminderPrefs, showReminder]);

  /**
   * Toggle a mandate's reminder. Permission is requested here and nowhere
   * else, after a click — never during render or on page load.
   */
  async function toggleReminder(mandateId: number) {
    if (!address || isReadOnly) return;
    const who = address;
    const enabled = hasReminder(reminderPrefs, mandateId);
    setError(null);
    setInfo(null);

    if (!enabled) {
      if (typeof window === "undefined" || typeof Notification === "undefined") {
        setInfo(tr("This browser does not support notifications. Upcoming charges are still listed here and can be added to your calendar."),
        );
        return;
      }
      setReminderBusy(mandateId);
      let permission = Notification.permission;
      if (permission === "default") {
        try {
          permission = await Notification.requestPermission();
        } catch {
          permission = "denied";
        }
      }
      if (addressRef.current !== who) return;
      setReminderBusy(null);
      if (permission !== "granted") {
        setInfo(tr("Notifications are blocked for this site. Allow them in your browser settings, then try again. Nothing was saved."),
        );
        return;
      }
    }

    const next = enabled
      ? removeReminder(reminderPrefs, mandateId)
      : addReminder(reminderPrefs, mandateId);
    setReminderPrefs(next);
    if (typeof window !== "undefined") {
      saveReminderPrefs(window.localStorage, who, next);
    }
    setInfo(
      enabled
        ? "Reminder off for this subscription."
        : "Reminder on. You will be notified about a day before the next charge while Payflow is open, or in the background where your browser supports scheduled notifications.",
    );
  }

  // Probe whether the deployed vault contract carries deposit_for. The sponsor
  // control stays hidden until the contract answers: a contract that predates
  // payflow-contract#29 cannot service the write, so offering it would only
  // fail at signing time.
  useEffect(() => {
    if (!address) {
      setFundSupport(null);
      return;
    }
    let live = true;
    void vaultSupportsDepositFor(address).then((supported) => {
      if (live) setFundSupport(supported);
    });
    return () => {
      live = false;
    };
  }, [address]);

  // Identify classic asset tokens in use by the subscriber's mandates
  const classicTokens = useMemo(() => {
    const tokenIds = new Set(
      (mandates ?? []).map((m) => m.token ?? config.contracts.token),
    );
    return configuredTokens.filter((t) => t.classicAsset && tokenIds.has(t.id));
  }, [mandates, configuredTokens]);

  const checkTrustlines = useCallback(async () => {
    if (!viewAddress || classicTokens.length === 0) {
      setMissingTrustlines([]);
      return;
    }
    const missing: ConfiguredToken[] = [];
    for (const t of classicTokens) {
      if (t.classicAsset) {
        const has = await payflow.checkTrustline(
          viewAddress,
          t.classicAsset.code,
          t.classicAsset.issuer,
        );
        if (!has) missing.push(t);
      }
    }
    setMissingTrustlines(missing);
  }, [viewAddress, classicTokens]);

  useEffect(() => {
    void checkTrustlines();
  }, [checkTrustlines]);

  async function handleAddTrustline(token: ConfiguredToken) {
    if (!address || !token.classicAsset) return;
    try {
      setBusy(`trustline-${token.symbol}`);
      setError(null);
      await payflow.addTrustline(
        address,
        signXdr,
        token.classicAsset.code,
        token.classicAsset.issuer,
      );
      setDone(`Added trustline for ${token.symbol}.`);
      await checkTrustlines();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setError(null);
    setDone(null);
    setInfo(null);
    try {
      setDone(await fn());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  /** Reveal Keep/Confirm for the sponsor deposit. One recipient at a time. */
  async function fundAnother() {
    if (recipientDisplayError || !fundAmountCheck.ok) return;
    setFundFor(fundRecipient.trim());
  }

  async function fundConfirmed() {
    if (!address || !signXdr || !fundFor || !fundAmountCheck.ok) return;
    await run(`fund-for-${fundFor}`, () =>
      payflow.depositFor(address, signXdr, fundFor, config.contracts.token, fundStroops),
    );
    setFundFor(null);
    setFundRecipient("");
    setFundAmount("");
  }

  async function handleCancelAll() {
    if (!address || isReadOnly) return;

    const allMandates = await chainMandatesOf(address, address);
    const toCancel = allMandates.filter((m) =>
      mandateStatus(m.status) === "Active" || mandateStatus(m.status) === "Paused",
    );

    if (toCancel.length === 0) {
      setError(tr("No active or paused mandates to cancel."));
      return;
    }

    if (
      !window.confirm(tr("This will cancel {0} mandate{1}. Continue?", { "0": toCancel.length, "1": toCancel.length !== 1 ? "s" : "" }),
      )
    ) {
      return;
    }

    setBusy("cancel-all");
    setError(null);
    setDone(null);

    const PAGE_SIZE = 50;
    let completed = 0;
    let failed = 0;

    for (let i = 0; i < toCancel.length; i += PAGE_SIZE) {
      const page = toCancel.slice(i, i + PAGE_SIZE);
      const promises = page.map((m) =>
        payflow
          .cancel(address, signXdr, m.id)
          .then(() => {
            completed += 1;
          })
          .catch((err) => {
            failed += 1;
            setError(err instanceof Error ? err.message : String(err));
          }),
      );
      await Promise.all(promises);
    }

    const result = completed
      ? `Cancelled ${completed} mandate${completed !== 1 ? "s" : ""}${
          failed > 0 ? ` (${failed} failed)` : ""
        }`
      : "No mandates were cancelled";

    setDone(result);
    await load();
    setBusy(null);
  }

  const activeCount = mandates?.filter((m) => m.status === "Active").length ?? 0;
  const runway = useMemo(() => {
    return computeVaultRunway(balance, mandates, config.contracts.token);
  }, [balance, mandates]);

  /**
   * Whether the contract behind these mandates can service a dated pause.
   */
  const pauseSupported = (mandates ?? []).some(
    (m) => mandatePauseUntil(m) !== null,
  );

  function openPausePicker(mandateId: number) {
    if (isReadOnly) return;
    setPauseFor(mandateId);
    const week = new Date(Date.now() + 7 * 86_400_000);
    setPauseDate(week.toISOString().slice(0, 10));
    setConfirmCancel(null);
    setError(null);
  }

  async function pauseUntil(mandateId: number) {
    if (!address || isReadOnly) return;
    const until = parsePauseDate(pauseDate);
    if (until === null) {
      setError(tr("Pick a date for the mandate to resume on."));
      return;
    }
    if (until * 1000 <= Date.now()) {
      setError(tr("Pick a date in the future."));
      return;
    }
    await run(`pause-until-${mandateId}`, () =>
      payflow.pauseUntil(address, signXdr, mandateId, until),
    );
    setPauseFor(null);
  }

  /**
   * The .ics is generated in the browser from the same mandates shown on this
   * page, so the calendar also works when the indexer is unreachable and the
   * list came from contract state.
   */
  function downloadCalendar() {
    if (!mandates) return;
    try {
      const calendar = buildUpcomingChargesCalendar(mandates);
      const blob = new Blob([calendar], { type: "text/calendar;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = CALENDAR_FILENAME;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not build the calendar file.",
      );
    }
  }

  /**
   * The date of a charge's transaction.
   *
   * Indexer charges carry a ledger, not a timestamp. The close time is read
   * from the transaction itself and any failure leaves "—": a payment record
   * must not invent today's date for a charge that settled months ago.
   */
  async function chargeDate(txHash: string): Promise<string> {
    try {
      const tx = await server.getTransaction(txHash);
      if ("createdAt" in tx) return createdAtDate(tx.createdAt as number);
    } catch {
      // RPC unavailable or the transaction is older than the node's history.
    }
    return "—";
  }

  /**
   * Export every charge settled against the subscriber's mandates as CSV.
   *
   * Per-charge amounts, fees and hashes exist only in the indexer; contract
   * state keeps just `charges_made`. The button is therefore disabled in
   * contract-only mode instead of shipping an empty file. If any mandate's
   * history cannot be read the whole export aborts: a file that silently omits
   * a subscription would look complete while understating what was paid.
   *
   * Read-only — it signs nothing — so a wallet on the wrong network can still
   * export. The account-change guards only stop one account's rows from being
   * written under another account's address.
   */
  async function exportPayments() {
    if (!viewAddress || !mandates || !mandatesFromApi) return;
    const who = viewAddress;
    setExporting(true);
    setError(null);
    setInfo(null);
    try {
      const histories = await Promise.all(
        mandates.map(async (mandate) => ({ mandate, result: await api.charges(mandate.id) })),
      );
      if (addressRef.current !== who) return;

      const unreadable = histories.filter(({ result }) => result === null);
      if (unreadable.length > 0) {
        throw new Error(tr("Could not read payment history for mandate{0} {1}. Nothing was exported, so the file cannot omit payments.", { "0": unreadable.length === 1 ? "" : "s", "1": unreadable
            .map(({ mandate }) => `#${mandate.id}`)
            .join(", ") }),
        );
      }

      const dateCache = new Map<string, string>();
      const rows: PaymentRow[] = [];
      for (const { mandate, result } of histories) {
        if (!result) continue;
        const tokenContract = mandate.token ?? config.contracts.token;
        // Read the token's metadata here rather than trusting the map rendered
        // above: decimals must be right even if the page has not finished
        // loading them, and a mandate in another token must use its own scale.
        const meta = await loadTokenMeta(tokenContract);
        for (const charge of result.charges) {
          let date = dateCache.get(charge.tx_hash);
          if (date === undefined) {
            date = await chargeDate(charge.tx_hash);
            dateCache.set(charge.tx_hash, date);
          }
          rows.push(paymentRow(charge, mandate, meta, tokenContract, date));
        }
      }
      if (addressRef.current !== who) return;

      if (rows.length === 0) {
        setInfo(tr("No payments to export yet. Charges appear here once they settle on-chain."));
        return;
      }

      const sorted = sortPaymentsNewestFirst(rows);
      const { from, to } = paymentDateRange(sorted);
      downloadCsv(buildPaymentsCsv(sorted), paymentsFilename(who, from, to));
      setInfo(tr("Exported {0} payment{1} to CSV.", { "0": sorted.length, "1": sorted.length === 1 ? "" : "s" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build the CSV file.");
    } finally {
      setExporting(false);
    }
  }

  if (!viewAddress) {
    return (
      <Panel title={tr("My account")}>
        <Empty
          title={tr("No wallet connected")}
          action={
            <button
              type="button"
              className="btn-primary"
              disabled={connecting}
              onClick={() => void connect()}
            >
              {connecting ?tr("Connecting…") :tr("Connect wallet")}
            </button>
          }
        >{tr("Connect a wallet to see your vault balance, fund it, and manage your subscriptions. Nothing is sent to the network until you approve a transaction in your wallet.")}</Empty>
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      {isReadOnly && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3"
        >
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-accent/20 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-accent">{tr("Read-only")}</span>
            <span className="text-sm text-foreground">{tr("Viewing subscriptions for")}{" "}
              <span className="font-mono">{shortAddress(viewAddress, 6)}</span>
            </span>
          </div>
          <span className="text-xs text-muted">{tr("Actions are hidden in read-only mode.")}</span>
        </div>
      )}

      {missingTrustlines.map((t) => (
        <div
          key={t.id}
          role="alert"
          className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-warning"
        >
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <p className="font-semibold text-sm">{tr("Trustline required for")}{" "}{t.symbol}</p>
              <p className="text-xs opacity-90">{tr("Your account needs a trustline for")}{" "}{t.name} ({t.symbol}{tr(") before subscriptions in this token can be funded or charged.")}</p>
            </div>
            {!isReadOnly && (
              <button
                type="button"
                className="btn-primary text-xs whitespace-nowrap self-start sm:self-auto"
                disabled={busy !== null || networkMismatch}
                onClick={() => void handleAddTrustline(t)}
              >
                {busy === `trustline-${t.symbol}`
                  ?tr("Adding trustline…")
                  :tr("Add {0} trustline", { "0": t.symbol })}
              </button>
            )}
          </div>
        </div>
      ))}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label={tr("Vault balance")}
          loading={balance === null}
          value={formatAmount(balance ?? 0n, vaultMeta)}
          hint={tr("Available to be charged")}
        />
        <Stat
          label={tr("Active subscriptions")}
          loading={mandates === null}
          value={activeCount}
        />
        <Stat
          label={tr("Runway")}
          loading={runway === null}
          value={
            runway
              ? runway.hasActiveMandates
                ? tr(runway.chargesCovered === 1 ? "{0} charge" : "{0} charges", { 0: runway.chargesCovered })
                : tr("No active charges")
              : "…"
          }
          hint={
            runway && runway.hasActiveMandates
              ? runway.runsOutDate
                ?tr("until {0}", { "0": formatDate(runway.runsOutDate) })
                :tr("fully funded")
              :tr("subscriptions billable")
          }
        />
      </div>

      {runway?.isLow && runway.hasActiveMandates && (
        <Notice tone="error">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <span>
              <strong>{tr("Low vault balance:")}</strong>{" "}{tr("Covers only")}{" "}{formatNumber(runway.chargesCovered)}{" "}
              {runway.chargesCovered === 1 ?tr("upcoming charge") :tr("upcoming charges")}.{" "}
              {runway.runsOutDate
                ?tr("Funds will run out on {0}.", { "0": formatDate(runway.runsOutDate) })
                :tr("Deposit funds to avoid subscription interruption.")}
            </span>
          </div>
        </Notice>
      )}

      {error && <Notice tone="error">{translateMessage(error)}</Notice>}
      {info && (
        <Notice tone="info">
          {/* Announced when the export finishes, so a screen-reader user knows
              the file was produced without having to hunt for the button. */}
          <span role="status">{translateMessage(info)}</span>
        </Notice>
      )}
      {done && (
        <Notice tone="ok">
          {done.length === 64 ? (
            <>{tr("Done. Transaction")}{" "}<TxLink hash={done} />
            </>
          ) : (
            done
          )}
        </Notice>
      )}

      {!isReadOnly && (
        <Panel
          title={tr("Fund your vault")}
          subtitle={tr("Charges are debited from this balance. Withdraw at any time — nothing is locked.")}
        >
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[12rem] flex-1">
              <AmountInput
                id="amount"
                label={tr("Amount ({0})", { "0": vaultMeta.symbol })}
                value={amount}
                onChange={setAmount}
                decimals={vaultMeta.decimals}
                placeholder="5.0"
                disabled={busy !== null}
                hint={tr("Accepts 5, 5.0 — and 5,0 where commas are decimals.")}
              />
            </div>
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null || networkMismatch}
              onClick={() =>
                void run("deposit", () =>
                  payflow.deposit(
                    address!,
                    signXdr,
                    config.contracts.token,
                    parseAmount(amount, vaultMeta.decimals),
                  ),
                )
              }
            >
              {busy === "deposit" ?tr("Depositing…") :tr("Deposit")}
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy !== null || networkMismatch}
              onClick={() =>
                void run("withdraw", () =>
                  payflow.withdraw(
                    address!,
                    signXdr,
                    config.contracts.token,
                    parseAmount(amount, vaultMeta.decimals),
                  ),
                )
              }
            >
              {busy === "withdraw" ?tr("Withdrawing…") :tr("Withdraw")}
            </button>
          </div>
        </Panel>
      )}

      {!isReadOnly && address && fundSupport === true && (
        <Panel
          title={tr("Fund another account")}
          subtitle={tr("Send tokens to someone else's vault. Only the recipient can withdraw — you cannot cancel or refund the deposit.")}
        >
          {fundFor ? (
            <div className="space-y-3">
              <p className="text-sm">{tr("{0} pays {1} into the vault of {2}.", { 0: shortAddress(address), 1: formatAmount(fundStroops, vaultMeta), 2: shortAddress(fundFor) })}</p>
              <p className="mt-1 text-xs text-muted">{tr("Only")}{" "}
                <span className="font-mono truncate">{shortAddress(fundFor)}</span>{" "}{tr("can withdraw it — you cannot cancel or refund this deposit.")}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy !== null || networkMismatch}
                  onClick={fundConfirmed}
                >
                  {busy === `fund-for-${fundFor}` ?tr("Funding…") :tr("Fund")}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy !== null}
                  onClick={() => setFundFor(null)}
                >{tr("Cancel")}</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[14rem] flex-1">
                <label className="label" htmlFor="fund-recipient">{tr("Recipient address")}</label>
                <input
                  id="fund-recipient"
                  className="input"
                  placeholder={tr("GABC…")}
                  value={fundRecipient}
                  onChange={(e) => setFundRecipient(e.target.value)}
                  aria-invalid={Boolean(recipientDisplayError)}
                  aria-describedby={recipientDisplayError ? "fund-recipient-error" : undefined}
                  disabled={busy !== null}
                />
                {recipientDisplayError && (
                  <p id="fund-recipient-error" className="mt-1 text-sm text-danger">
                    {translateMessage(recipientDisplayError)}
                  </p>
                )}
              </div>
              <div className="min-w-[12rem] flex-1">
                <AmountInput
                  id="fund-amount"
                  label={tr("Amount ({0})", { "0": vaultMeta.symbol })}
                  value={fundAmount}
                  onChange={setFundAmount}
                  decimals={vaultMeta.decimals}
                  placeholder="5.0"
                  disabled={busy !== null}
                />
              </div>
              <button
                type="button"
                className="btn-primary"
                disabled={
                  busy !== null ||
                  networkMismatch ||
                  Boolean(recipientDisplayError) ||
                  !fundAmountCheck.ok
                }
                onClick={fundAnother}
              >
                {busy === "fund-another" ?tr("Funding…") :tr("Fund")}
              </button>
            </div>
          )}
        </Panel>
      )}

      <Panel
        title={tr("Vault history")}
        subtitle={tr("Deposits, withdrawals and debits behind your balance.")}
      >
        {history === null ? (
          <Empty>{tr("Loading history…")}</Empty>
        ) : history.length === 0 ? (
          indexerAvailable ? (
            <Empty
              title={tr("No vault activity yet")}
              action={
                !isReadOnly ? (
                  <a href="#amount" className="btn-primary">{tr("Make a deposit")}</a>
                ) : undefined
              }
            >{tr("Deposits, withdrawals and debit charges appear here as they settle. Fund the vault above so charges have a balance to draw from.")}</Empty>
          ) : null
        ) : (
          <div className="space-y-2">
            {history.map((event) => {
              const label = vaultEventLabel(event);
              const isCredit = vaultEventTone(event) === "ok";
              const eventAmount = `${isCredit ? "+" : "-"}${formatTokenValue(event.amount, 4, vaultMeta.decimals)}`;
              return (
                <div
                  key={event.tx_hash}
                  className="flex items-center justify-between gap-3 rounded-lg border border-edge p-3"
                  aria-label={tr("{0} {1} {2}, ledger {3}", { "0": tr(label), "1": eventAmount, "2": vaultMeta.symbol, "3": String(event.ledger) })}
                >
                  <div className="flex items-center gap-3 text-sm">
                    <span className="font-medium">{typeof label === "string" ? tr(label) : label}</span>
                    <span className="mono text-xs text-muted">{tr("tx")}</span>
                    <TxLink hash={event.tx_hash} />
                  </div>
                  <div className="text-right">
                    <span
                      className={`font-semibold tabular-nums ${
                        isCredit ? "text-accent" : "text-danger"
                      }`}
                    >
                      {eventAmount} {vaultMeta.symbol}
                    </span>
                    <div className="text-xs text-muted">{tr("ledger")}{" "}{event.ledger}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {history !== null && !indexerAvailable && (
          <Notice tone="info">{tr("Vault history is not available in contract-only mode. It requires the payflow-backend indexer (set NEXT_PUBLIC_API_URL). Deposits, withdrawals and debits still update your on-chain balance; only the event list is missing.")}</Notice>
        )}
      </Panel>

      <Panel
        title={tr("My subscriptions")}
        subtitle={tr("Add the next charge to your calendar, or export past payments for your records.")}
        actions={
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-ghost whitespace-nowrap"
              disabled={activeCount === 0}
              onClick={downloadCalendar}
              title={
                activeCount === 0
                  ?tr("No active subscriptions to add")
                  :tr("Download an .ics file for Google or Apple Calendar")
              }
            >{tr("Add to calendar")}</button>
            {/*
              Read-only, so it stays enabled on a mismatched network: exporting
              records does not need the wallet's network to match the app's.
              Disabled only when there is nothing it can honestly export.
            */}
            <button
              type="button"
              className="btn-ghost whitespace-nowrap"
              disabled={exporting || !mandatesFromApi || (mandates?.length ?? 0) === 0}
              onClick={() => void exportPayments()}
              aria-label={tr("Export my payments as CSV")}
              title={
                !mandatesFromApi
                  ?tr("Payment history needs the payflow indexer (set NEXT_PUBLIC_API_URL)")
                  : (mandates?.length ?? 0) === 0
                    ?tr("No subscriptions to export")
                    :tr("Download a CSV of every charge against your subscriptions")
              }
            >
              {exporting ?tr("Exporting…") :tr("Export CSV")}
            </button>
          </div>
        }
      >
        {!mandatesFromApi && mandates !== null && (
          <Notice tone="info">{tr("Payment history — and this CSV export — come from the payflow indexer, which is not reachable here, so the export is unavailable in contract-only mode. The chain records how many charges each mandate has taken, but not their amounts or transaction hashes. Set NEXT_PUBLIC_API_URL and rebuild to enable it; everything else on this page still works without a backend.")}</Notice>
        )}
        {mandates === null ? (
          <SkeletonRows rows={2} label={tr("Loading subscriptions")} />
        ) : mandates.length === 0 ? (
          <Empty
            title={tr("No subscriptions yet")}
            action={
              !isReadOnly ? (
                <Link href="/subscribe" className="btn-primary">{tr("Browse plans")}</Link>
              ) : undefined
            }
          >{tr("Subscribing to a plan opens a mandate, and every mandate shows up here with its next charge date. You can pause or cancel any of them from this page.")}</Empty>
        ) : (
          <div className="space-y-3">
            {!isReadOnly && (
              <p className="mt-3 text-xs text-muted">{tr("Browser reminders are opt-in per subscription and ask for notification permission only when you choose “Remind me”. While Payflow is open they fire a day before the charge; in browsers that support scheduled notifications the installed app can deliver them in the background. Reminders stop when a subscription is cancelled or completed.")}</p>
            )}
            {!isReadOnly && (
              <div className="flex gap-2 mt-3">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy !== null || networkMismatch}
                  onClick={handleCancelAll}
                >
                  {busy !== null || networkMismatch ?tr("Cancelling…") :tr("Cancel all")}
                </button>
              </div>
            )}
            <VirtualList
              items={mandates}
              threshold={100}
              itemHeight={180}
              keyExtractor={(m) => m.id}
              listAriaLabel="Subscriptions"
              className="space-y-3"
              renderItem={(m) => {
                const terminal = m.status === "Cancelled" || m.status === "Completed";
                const meta = metaFor(metas, m.token ?? config.contracts.token);
                const resumeAt = mandatePauseUntil(m);
                const resumes = resumeDate(resumeAt) && resumeAt ? formatDate(resumeAt) : null;
                const pastDueUntil = mandatePastDueUntil(m);
                const isPastDue = mandateIsPastDue(m);
                const trial = describeTrialEnd(m);
                const discounted = nextChargeAmount(m);
                const badge = discountBadge(m);
                const remaining = remainingDiscountCharges(m);
                const schedule = buildChargeSchedule(m);
                const nextAmount = schedule.charges[0]?.amount;
                const sameToken =
                  (m.token ?? config.contracts.token) === config.contracts.token;
                const shortfall =
                  nextAmount === undefined || !sameToken
                    ? null
                    : chargeShortfall(balance, nextAmount);
                const pastDueShortfall =
                  isPastDue && sameToken && nextAmount !== undefined
                    ? chargeShortfall(balance, nextAmount)
                    : null;

                return (
                  <div key={m.id} className="rounded-lg border border-edge p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/mandates/?id=${m.id}`}
                            className="font-medium hover:underline text-soft focus:outline-none focus:ring-1 focus:ring-accent rounded"
                          >{tr("Mandate #")}{m.id}
                          </Link>
                          <Badge status={m.status} />
                          {isPastDue && (
                            <span className="rounded-full bg-danger/15 px-2 py-0.5 text-xs font-medium text-danger">{tr("Past due")}</span>
                          )}
                          {resumes && (
                            <span className="text-xs text-muted">{tr("resumes")}{" "}{resumes}</span>
                          )}
                          {pastDueUntil && (
                            <span className="text-xs text-muted">{tr("grace period ends")}{" "}{formatDate(pastDueUntil)}</span>
                          )}
                          {trial && (
                            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">{tr("Free trial")}</span>
                          )}
                          {badge && (
                            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                              {badge}
                            </span>
                          )}
                          {m.ended_by === "merchant" && (
                            <span className="text-xs text-muted">{tr("ended by the merchant")}</span>
                          )}
                          {m.status === "Paused" && pausedBy.get(m.id) === "merchant" && (
                            <span className="text-xs text-muted">{tr("paused by the merchant")}</span>
                          )}
                        </div>
                        <div className="mt-1 text-sm text-muted">
                          {discounted !== null ? (
                            <>
                              <span className="font-medium text-fg">
                                {formatTokenValue(discounted, 4, meta.decimals)} {meta.symbol}
                              </span>{" "}
                              <span className="text-xs line-through">
                                {formatTokenValue(m.amount, 4, meta.decimals)} {meta.symbol}
                              </span>{" "}
                            </>
                          ) : (
                            <>
                              {formatTokenValue(m.amount, 4, meta.decimals)} {meta.symbol}{" "}
                            </>
                          )}
                          {formatPeriod(m.period)}{" "}{tr("· to")}{" "}<MerchantAccount value={m.merchant} />
                        </div>
                        {badge && (
                          <div className="mt-1 text-xs text-accent">
                            {discounted !== null ? (
                              <>{tr("You pay")}{" "}{formatTokenValue(discounted, 4, meta.decimals)}{" "}
                                {meta.symbol}{" "}{tr("for the next charge")}{remaining === null
                                  ? "."
                                  : remaining === 1
                                    ?tr(", then the full price.")
                                    :tr(", then the full price. {0} discounted charges left.", { "0": remaining })}
                              </>
                            ) : remaining === 0 ? (
                              <>{tr("The discount has run out — you pay the full price now.")}</>
                            ) : (
                              <>{tr("The merchant set a discount on this subscription.")}</>
                            )}
                          </div>
                        )}
                        <div className="mt-1 text-xs text-muted">
                          {formatNumber(m.charges_made)}{" "}{tr("charge")}{m.charges_made === 1 ? "" :tr("s")}{" "}{tr("taken")}{m.max_charges > 0 &&tr(" of {0}", { "0": m.max_charges })}
                          {tr(" · next ")}
                          {m.status === "Active" ? <TimeAgo value={m.next_charge} /> : "—"}
                        </div>
                        {trial && (
                          <div className="mt-1 text-xs text-accent">
                            {trial}{tr(". Cancel before then and you pay nothing.")}</div>
                        )}
                        {mandateSupportsSpendLimit(m) && (
                          <div className="mt-1 text-xs text-accent">
                            {tr(spendLimitInfo())}
                          </div>
                        )}
                        {isPastDue && pastDueShortfall !== null && (
                          <Notice tone="error">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div>
                                <p className="font-medium">{tr("This subscription is past due — your vault is short by")}{" "}
                                  {formatAmount(pastDueShortfall, meta)}{" "}{tr("for the next charge.")}</p>
                                {pastDueUntil && (
                                  <p className="mt-1 text-xs text-muted">{tr("The grace period ends")}{" "}{formatDate(pastDueUntil)}{tr(". After that, the mandate may expire if the charge cannot be settled.")}</p>
                                )}
                              </div>
                              {!isReadOnly && (
                                <button
                                  type="button"
                                  className="btn-primary whitespace-nowrap"
                                  disabled={busy !== null || networkMismatch}
                                  onClick={() =>
                                    void run(`deposit-past-due-${m.id}`, () =>
                                      payflow.deposit(
                                        address!,
                                        signXdr,
                                        config.contracts.token,
                                        parseAmount(
                                          formatTokenValue(pastDueShortfall + 1n, 4, meta.decimals),
                                          meta.decimals,
                                        ),
                                      ),
                                    )
                                  }
                                >
                                  {busy === `deposit-past-due-${m.id}` ?tr("Depositing…") :tr("Deposit to fix")}
                                </button>
                              )}
                            </div>
                          </Notice>
                        )}
                      </div>

                    {!terminal && !isReadOnly && (
                      <div className="flex flex-wrap items-center gap-2 mt-4 pt-3 border-t border-edge">
                        {/* Subscriber can pause, but cannot resume if paused by merchant */}
                        {m.status === "Active" && (
                          <button
                            type="button"
                            className="btn-ghost"
                            disabled={busy !== null || networkMismatch}
                            onClick={() =>
                              void run(`pause-${m.id}`, () =>
                                payflow.setPaused(
                                  address!,
                                  signXdr,
                                  m.id,
                                  true,
                                ),
                              )
                            }
                          >{tr("Pause")}</button>
                        )}
                        {/* Opting in is local and needs no network, so a
                            mismatched wallet network does not block it. */}
                        {reminderEligible(m) && (
                          <button
                            type="button"
                            className={`btn-ghost ${
                              hasReminder(reminderPrefs, m.id) ? "text-accent" : ""
                            }`}
                            disabled={reminderBusy === m.id}
                            aria-pressed={hasReminder(reminderPrefs, m.id)}
                            title={tr("Notify me a day before this subscription charges")}
                            onClick={() => void toggleReminder(m.id)}
                          >
                            {reminderBusy === m.id
                              ?tr("Saving…")
                              : hasReminder(reminderPrefs, m.id)
                                ?tr("Reminder on")
                                :tr("Remind me")}
                          </button>
                        )}
                        {m.status === "Paused" && pausedBy.get(m.id) !== "merchant" && (
                          <button
                            type="button"
                            className="btn-ghost"
                            disabled={busy !== null || networkMismatch}
                            onClick={() =>
                              void run(`pause-${m.id}`, () =>
                                payflow.setPaused(
                                  address!,
                                  signXdr,
                                  m.id,
                                  false,
                                ),
                              )
                            }
                          >{tr("Resume")}</button>
                        )}
                        {pauseSupported &&
                          (pauseFor === m.id ? (
                            <>
                              <label
                                className="sr-only"
                                htmlFor={`pause-until-${m.id}`}
                              >{tr("Resume date for mandate")}{" "}{m.id}
                              </label>
                              <input
                                id={`pause-until-${m.id}`}
                                type="date"
                                className="input"
                                min={minPauseDate()}
                                value={pauseDate}
                                disabled={busy !== null}
                                onChange={(e) => setPauseDate(e.target.value)}
                              />
                              <button
                                type="button"
                                className="btn-primary"
                                disabled={busy !== null || networkMismatch}
                                onClick={() => void pauseUntil(m.id)}
                              >
                                {busy === `pause-until-${m.id}`
                                  ?tr("Pausing…")
                                  :tr("Pause until…")}
                              </button>
                              <button
                                type="button"
                                className="btn-ghost"
                                disabled={busy !== null}
                                onClick={() => setPauseFor(null)}
                              >{tr("Back")}</button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn-ghost"
                              disabled={busy !== null || networkMismatch}
                              onClick={() => openPausePicker(m.id)}
                            >{tr("Pause until…")}</button>
                          ))}
                        {confirmCancel === m.id ? (
                          <>
                            <button
                              type="button"
                              className="btn-ghost"
                              disabled={busy !== null}
                              autoFocus
                              onClick={() => setConfirmCancel(null)}
                            >{tr("Keep")}</button>
                            <button
                              type="button"
                              className="btn-danger"
                              disabled={busy !== null || networkMismatch}
                              aria-label={tr("Confirm cancelling subscription #{0}", { "0": m.id })}
                              onClick={() =>
                                void run(`cancel-${m.id}`, () =>
                                  payflow.cancel(address!, signXdr, m.id),
                                ).then(() => setConfirmCancel(null))
                              }
                            >
                              {busy === `cancel-${m.id}` ?tr("Cancelling…") :tr("Confirm")}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn-ghost text-danger"
                            disabled={busy !== null || networkMismatch}
                            aria-label={tr("Cancel subscription #{0}", { "0": m.id })}
                            onClick={() => setConfirmCancel(m.id)}
                          >{tr("Cancel")}</button>
                        )}
                      </div>
                    )}
                  </div>

                    {schedule.charges.length > 0 && (
                      <section
                        className="mt-4 border-t border-edge pt-3"
                        aria-labelledby={`schedule-${m.id}`}
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                          <h3 id={`schedule-${m.id}`} className="text-sm font-medium">{tr("Upcoming charges")}</h3>
                          <span className="text-xs text-muted">{tr("Next")}{" "}{formatNumber(schedule.charges.length)}{" "}{tr("total")}{" "}
                            {formatAmount(schedule.total, meta)}
                          </span>
                        </div>
                        <ol className="mt-2 space-y-1.5">
                          {schedule.charges.map((charge) => (
                            <li
                              key={charge.due}
                              className="flex items-baseline justify-between gap-3 text-sm"
                            >
                              <time
                                dateTime={new Date(charge.due * 1000).toISOString()}
                                className="text-muted"
                              >
                                {formatDate(charge.due)}
                              </time>
                              <span className="tabular-nums">
                                {formatAmount(charge.amount, meta)}
                              </span>
                            </li>
                          ))}
                        </ol>
                        <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted">
                          <span>{tr("Running total")}{" "}
                            <strong className="font-medium text-fg">
                              {formatAmount(schedule.total, meta)}
                            </strong>
                          </span>
                          {schedule.finalDate !== null && (
                            <span>{tr("Final charge")}{" "}{formatDate(schedule.finalDate)}</span>
                          )}
                        </div>
                        {shortfall !== null && (
                          <p
                            role="status"
                            className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
                          >{tr("Your vault is short by")}{" "}{formatAmount(shortfall, meta)}{" "}{tr("for the next charge. Deposit before")}{" "}{formatDate(m.next_charge)}{" "}{tr("or it will fail.")}</p>
                        )}
                      </section>
                    )}
                  </div>
                );
              }}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}

function spendLimitInfo(): string {
  // Spend limit read requires an RPC call; defer to useEffect later.
  return "Spend limit: loading";
}

export default function AccountPage() {
  const { t: tr } = useI18n();
  return (
    <Suspense fallback={<SkeletonRows rows={3} label={tr("Loading account")} />}>
      <AccountInner />
    </Suspense>
  );
}
