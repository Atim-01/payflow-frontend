"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, checkWebhookUrl, type ApiMandate, type ApiPlan, type ApiWebhook, type MerchantSummary, type StreamEvent } from "@/lib/api";
import { RevenueChart } from "@/components/RevenueChart";
import { WebhookDeliveryHistory } from "@/components/WebhookDeliveryHistory";
import { buildCsv, downloadCsv, exportFilename, type ChargeRow } from "@/lib/csv";
import { fillBuckets, parseRevenue, type BucketSize, type RevenuePoint } from "@/lib/revenue";
import { parseMerchantChurn, type MerchantChurnMonth } from "@/lib/churn";
import { chainMandatesFor, chainMerchantSummary, chainPlanSubscriberCount, chainPlansOf, chainUnpaidMandates, endable, mandateFunding, type UnpaidMandate } from "@/lib/chain";
import { config, type ConfiguredToken } from "@/lib/config";
import { VirtualList } from "@/components/VirtualList";

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
import {
  checkDiscountBps,
  checkDiscountCharges,
  discountedAmount,
  discountBadge,
  remainingDiscountCharges,
  supportsDiscounts,
} from "@/lib/discount";
import { MAX_NAME_LEN, mandatePauseUntil, mandateRefundableAmount, mandateSupportsRefund, nameByteLength, payflow, server } from "@/lib/payflow";
import { useWallet } from "@/lib/wallet";
import { useStream } from "@/lib/stream";
import {
  checkAmount,
  feeSplit,
  formatAmount,
  formatDate,
  formatFeeBps,
  formatPeriod,
  fromStroops,
  type FeeSplit,
  type TokenMeta,
} from "@/lib/format";
import { metaFor, useTokenMetas } from "@/lib/token";
import { supportsTrials, trialBadge, TRIAL_OPTIONS } from "@/lib/trial";
import {
  CUSTOM_PERIOD,
  DEFAULT_PERIOD,
  PERIOD_PRESETS,
  PERIOD_UNITS,
  checkCustomPeriod,
  checkPeriodSeconds,
  unitLabel,
  type PeriodCheck,
} from "@/lib/period";
import { countOpenMandates } from "@/lib/plans";
import { formatUsdEstimate, formatUsdcEstimate, useXlmUsdPrice } from "@/lib/price";
import { AmountInput } from "@/components/AmountInput";
import { CopyButton } from "@/components/CopyButton";
import { AddressLink, Badge, Empty, Notice, Panel, SkeletonRows, Stat, TimeAgo, TxLink } from "@/components/ui";

/** How far back the revenue chart looks, in days. */
const REVENUE_WINDOW_DAYS = 90;

/**
 * "subscriber pays X, you receive Y after the Z% fee".
 *
 * All three figures come from one bigint split in the token's own scale, so
 * the net shown here is exactly what `charge` credits to the merchant — never
 * a percentage of a rounded display string.
 */
function FeePreview({
  split,
  feeBps,
  meta,
  usdEstimate,
}: {
  split: FeeSplit;
  feeBps: number;
  meta: TokenMeta;
  usdEstimate?: string | null;
}) {
  return (
    <span>
      Subscriber pays {formatAmount(split.gross, meta)}
      {usdEstimate ? ` (≈ ${usdEstimate})` : ""} · protocol fee{" "}
      {formatAmount(split.fee, meta)} ({formatFeeBps(feeBps)}) · you receive{" "}
      {formatAmount(split.net, meta)}.
    </span>
  );
}

type ChurnPanelState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "error" }
  | { status: "data"; months: MerchantChurnMonth[] };

function MerchantChurnPanel({
  merchant,
  apiConfigured,
}: {
  merchant: string;
  apiConfigured: boolean;
}) {
  const [state, setState] = useState<ChurnPanelState>({ status: "loading" });

  useEffect(() => {
    if (!apiConfigured) {
      setState({ status: "unavailable" });
      return;
    }

    let live = true;
    setState({ status: "loading" });
    void api
      .merchantChurn(merchant)
      .then((body) => {
        if (!live) return;
        if (body === null) {
          setState({ status: "unavailable" });
          return;
        }
        const months = parseMerchantChurn(body, merchant);
        setState(months === null ? { status: "error" } : { status: "data", months });
      })
      .catch(() => {
        if (live) setState({ status: "unavailable" });
      });

    return () => {
      live = false;
    };
  }, [apiConfigured, merchant]);

  if (!apiConfigured) {
    return (
      <Notice tone="info">
        Historical churn analytics require the payflow backend. Configure NEXT_PUBLIC_API_URL
        to enable this report; contract-only mode does not retain historical lifecycle events.
      </Notice>
    );
  }

  return (
    <Panel
      title="Monthly subscriber activity"
      subtitle="Counts are subscriptions (mandates), bucketed by event time. Net change is started minus subscriber cancellations, merchant endings, and completed subscriptions."
    >
      {state.status === "loading" ? (
        <SkeletonRows rows={2} label="Loading monthly subscriber activity" />
      ) : state.status === "unavailable" ? (
        <Empty title="Historical churn analytics unavailable">
          The payflow backend is not reachable or does not serve this report yet. Contract state
          cannot reconstruct historical subscription activity.
        </Empty>
      ) : state.status === "error" ? (
        <Notice tone="error">
          The backend returned an incomplete or inconsistent churn report, so these metrics are
          hidden rather than shown as misleading counts.
        </Notice>
      ) : state.months.length === 0 ? (
        <Empty title="No subscription activity in this report">
          No lifecycle events were returned for the reported monthly buckets.
        </Empty>
      ) : (
        <div
          className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          role="region"
          aria-label="Monthly subscriber activity table"
          tabIndex={0}
        >
          <table className="w-full min-w-[760px] text-left text-sm">
            <caption className="sr-only">
              Monthly subscription starts, departures, completions, and net change. Completed
              subscriptions are included in the net calculation.
            </caption>
            <thead>
              <tr className="border-b border-edge text-muted">
                <th scope="col" className="py-2 pr-3 font-medium">Month (UTC)</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Started</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Subscriber cancellations
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Merchant-ended</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Completed</th>
                <th scope="col" className="py-2 text-right font-medium">Net subscriber change</th>
              </tr>
            </thead>
            <tbody>
              {state.months.map((month) => (
                <tr key={month.bucket} className="border-b border-edge last:border-0">
                  <th scope="row" className="py-2 pr-3 font-medium">{month.bucket}</th>
                  <td className="py-2 pr-3 text-right tabular-nums">{month.started}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{month.cancelled}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{month.ended}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{month.completed}</td>
                  <td className="py-2 text-right tabular-nums">
                    {month.net > 0
                      ? `+${month.net} (increase)`
                      : month.net < 0
                        ? `${month.net} (decrease)`
                        : "0 (no change)"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/**
 * Events the backend can deliver to a merchant's webhook endpoints.
 *
 * Kept as a fixed list so the merchant cannot invent events the backend does
 * not send — payflow-backend#5 defines the final set.
 */
const WEBHOOK_EVENTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "charge", label: "Charge settled" },
  { value: "refund", label: "Refund issued" },
  { value: "mandate_ended", label: "Mandate ended" },
];

/**
 * Webhook settings: register, list and test HTTPS endpoints the backend
 * POSTs charge events to. Hidden entirely when the backend does not serve
 * the webhook endpoints (NEXT_PUBLIC_API_URL unset, or a 404 from the indexer).
 */
function WebhooksPanel({
  merchant,
  apiConfigured,
}: {
  merchant: string;
  apiConfigured: boolean;
}) {
  const [webhooks, setWebhooks] = useState<ApiWebhook[] | null>(null);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [showSecret, setShowSecret] = useState<{ id: string; secret: string; rotated?: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!apiConfigured) {
      setWebhooks(null);
      return;
    }
    setWebhooks(null);
    let live = true;
    void api.webhooks(merchant).then((list) => {
      if (live) setWebhooks(list);
    });
    return () => {
      live = false;
    };
  }, [apiConfigured, merchant]);

  if (!apiConfigured) return null;

  const urlCheck = checkWebhookUrl(url);
  const usable = urlCheck.ok && events.length > 0;

  async function addWebhook() {
    if (!urlCheck.ok || events.length === 0) return;
    setBusy("webhook-add");
    setError(null);
    setDone(null);
    try {
      const created = await api.addWebhook(merchant, { url: urlCheck.url, events });
      if (!created) {
        setError("The backend could not create the webhook.");
        return;
      }
      setShowSecret({ id: created.id, secret: created.secret ?? "" });
      setWebhooks((prev) => (prev ? [...prev, created] : [created]));
      setUrl("");
      setEvents([]);
      setDone("Webhook created.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function deleteWebhook(id: string) {
    setBusy(`webhook-delete-${id}`);
    try {
      const ok = await api.deleteWebhook(merchant, id);
      if (!ok) {
        setError("The backend could not delete the webhook.");
        return;
      }
      setWebhooks((prev) => (prev ? prev.filter((w) => w.id !== id) : prev));
      setDone("Webhook deleted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setConfirmDelete(null);
    }
  }

  async function testWebhook(id: string) {
    setBusy(`webhook-test-${id}`);
    try {
      const ok = await api.testWebhook(merchant, id);
      if (!ok) {
        setError("The test event could not be sent.");
        return;
      }
      setDone("Test event sent.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function rotateSecret(id: string) {
    setBusy(`webhook-rotate-${id}`);
    try {
      const result = await api.rotateWebhookSecret(merchant, id);
      if (!result) {
        setError("The backend could not rotate the secret.");
        return;
      }
      setShowSecret({ id, secret: result.secret, rotated: true });
      setDone("Secret rotated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setConfirmRotate(null);
    }
  }

  function toggleEvent(value: string) {
    setEvents((prev) => (prev.includes(value) ? prev.filter((e) => e !== value) : [...prev, value]));
  }

  return (
    <Panel
      title="Webhook settings"
      subtitle="Endpoints the backend POSTs charge events to. Each request is signed with a secret shown once when the webhook is created."
    >
      {error && <Notice tone="error">{error}</Notice>}
      {done && <Notice tone="ok">{done}</Notice>}
      {webhooks === null ? (
        <SkeletonRows rows={2} label="Loading webhooks" />
      ) : (
        <>
          <div className="mt-3 rounded-lg border border-edge p-3">
            <p className="text-sm font-medium">Add a webhook</p>
            <div className="mt-2 flex flex-wrap items-end gap-3">
              <div className="min-w-[16rem] flex-1">
                <label className="label" htmlFor="webhook-url">
                  URL
                </label>
                <input
                  id="webhook-url"
                  className="input"
                  placeholder="https://hooks.example.com/payflow"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={busy === "webhook-add"}
                  aria-invalid={url.length > 0 && !urlCheck.ok}
                  aria-describedby={
                    url.length > 0 && !urlCheck.ok ? "webhook-url-error" : undefined
                  }
                />
                {url.length > 0 && !urlCheck.ok && (
                  <p id="webhook-url-error" className="mt-1 text-sm text-danger">
                    {urlCheck.message}
                  </p>
                )}
              </div>
              <div className="min-w-[14rem] flex-1">
                <p className="text-sm font-medium mb-2">Events</p>
                <div className="space-y-1">
                  {WEBHOOK_EVENTS.map((option) => (
                    <label key={option.value} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={events.includes(option.value)}
                        onChange={() => toggleEvent(option.value)}
                        disabled={busy === "webhook-add"}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              </div>
              <button
                type="button"
                className="btn-primary"
                disabled={busy === "webhook-add" || !usable}
                onClick={addWebhook}
              >
                {busy === "webhook-add" ? "Adding…" : "Add webhook"}
              </button>
            </div>
          </div>

          {showSecret && (
            <div className="mt-3 rounded-lg border border-accent/40 bg-accent/10 p-3">
              <p className="text-sm font-medium">
                {showSecret.rotated ? "New signing secret (shown once)" : "Signing secret (shown once)"}
              </p>
              <div className="mt-2 flex items-end gap-2">
                <input
                  id="webhook-secret"
                  className="input mono flex-1"
                  readOnly
                  value={showSecret.secret}
                  aria-label="Copy the signing secret"
                />
                <CopyButton value={showSecret.secret} label="signing secret" />
              </div>
              <p className="mt-1 text-xs text-muted">
                {showSecret.rotated
                  ? "Copy it now — the backend never returns this secret again. The old secret remains valid for a brief overlap period so you can update your system without missing events."
                  : "Copy it now — the backend never returns this secret again."}
              </p>
            </div>
          )}

          <div className="mt-4 space-y-3">
            {webhooks.length === 0 ? (
              <Empty
                title="No webhooks yet"
              >
                Register an endpoint above so the backend can POST charge
                events to your own systems. Events are delivered over https
                and signed with the webhook{"'s"} secret.
              </Empty>
            ) : (
              webhooks.map((w) => (
                <div key={w.id} className="min-w-0 rounded-lg border border-edge p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 max-w-full">
                      <div className="font-medium mono truncate" title={w.url}>
                        {w.url}
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {w.events.join(", ")} · {formatDate(w.created_at)}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {confirmDelete === w.id ? (
                        <>
                          <button
                            type="button"
                            className="btn-ghost"
                            disabled={busy !== null}
                            onClick={() => setConfirmDelete(null)}
                          >
                            Keep
                          </button>
                          <button
                            type="button"
                            className="btn-danger"
                            disabled={busy !== null}
                            onClick={() => void deleteWebhook(w.id)}
                          >
                            {busy === `webhook-delete-${w.id}` ? "Deleting…" : "Delete"}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn-ghost text-danger"
                          disabled={busy !== null}
                          onClick={() => setConfirmDelete(w.id)}
                          aria-label={`Delete webhook ${w.url}`}
                        >
                          Delete
                        </button>
                      )}
                      {confirmRotate === w.id ? (
                        <>
                          <button
                            type="button"
                            className="btn-ghost"
                            disabled={busy !== null}
                            onClick={() => setConfirmRotate(null)}
                          >
                            Keep current
                          </button>
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={busy !== null}
                            onClick={() => void rotateSecret(w.id)}
                          >
                            {busy === `webhook-rotate-${w.id}` ? "Rotating…" : "Confirm: rotate"}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={busy !== null}
                          onClick={() => setConfirmRotate(w.id)}
                          aria-label={`Rotate secret for webhook ${w.url}`}
                        >
                          Rotate secret
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={busy !== null}
                        onClick={() => void testWebhook(w.id)}
                      >
                        {busy === `webhook-test-${w.id}` ? "Testing…" : "Send test"}
                      </button>
                    </div>
                  </div>
                  <WebhookDeliveryHistory merchant={merchant} webhookId={String(w.id)} />
                </div>
              ))
            )}
          </div>
        </>
      )}
    </Panel>
  );
}

/**
 * The discount a merchant can attach to one mandate.
 *
 * The rate is a percentage the merchant types; it is converted to basis
 * points in integer arithmetic, and the preview says what the subscriber pays
 * while the discount runs and what they pay after it. The discount can only
 * lower the price, so the preview never shows more than the plan's price.
 */
function DiscountForm({
  amount,
  meta,
  busy,
  onCancel,
  onApply,
}: {
  amount: bigint;
  meta: TokenMeta;
  busy: boolean;
  onCancel: () => void;
  onApply: (bps: number, charges: number) => void;
}) {
  const [percent, setPercent] = useState("10");
  const [charges, setCharges] = useState("3");
  const bpsCheck = checkDiscountBps(percent);
  const chargesCheck = checkDiscountCharges(charges);
  const usable = bpsCheck.ok && chargesCheck.ok;

  return (
    <div className="mt-3 rounded-lg border border-edge p-3">
      <p className="text-sm font-medium">Discount this mandate</p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <div className="min-w-[7rem] flex-1">
          <label className="label" htmlFor="discount-percent">
            Discount (%)
          </label>
          <input
            id="discount-percent"
            className="input"
            inputMode="decimal"
            placeholder="10"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            aria-invalid={!bpsCheck.ok}
            aria-describedby={bpsCheck.ok ? undefined : "discount-percent-error"}
            disabled={busy}
          />
        </div>
        <div className="min-w-[9rem] flex-1">
          <label className="label" htmlFor="discount-charges">
            Charges to cover
          </label>
          <input
            id="discount-charges"
            className="input"
            inputMode="numeric"
            placeholder="3"
            value={charges}
            onChange={(e) => setCharges(e.target.value)}
            aria-invalid={!chargesCheck.ok}
            aria-describedby={chargesCheck.ok ? undefined : "discount-charges-error"}
            disabled={busy}
          />
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !usable}
          onClick={() => {
            if (!bpsCheck.ok || !chargesCheck.ok) return;
            onApply(bpsCheck.bps, chargesCheck.charges);
          }}
        >
          {busy ? "Applying…" : "Apply discount"}
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>

      {!bpsCheck.ok && (
        <p id="discount-percent-error" className="mt-2 text-sm text-danger">
          {bpsCheck.message}
        </p>
      )}
      {!chargesCheck.ok && (
        <p id="discount-charges-error" className="mt-2 text-sm text-danger">
          {chargesCheck.message}
        </p>
      )}

      {bpsCheck.ok && chargesCheck.ok && (
        <p className="mt-2 text-sm text-muted">
          Subscriber pays {formatAmount(discountedAmount(amount, bpsCheck.bps), meta)}{" "}
          for the next {chargesCheck.charges === 1 ? "charge" : `${chargesCheck.charges} charges`},{" "}
          then {formatAmount(amount, meta)}.
          {discountedAmount(amount, bpsCheck.bps) === 0n && (
            <> This discount rounds the charge down to zero, which the vault cannot debit.</>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * The refund a merchant can issue on one mandate.
 *
 * The amount is capped at what the merchant received (net of fees) for that
 * mandate. The form shows the maximum refundable amount and confirms the
 * action with a dialog stating the amount and recipient.
 */
function RefundForm({
  maxRefund,
  meta,
  amount,
  onAmountChange,
  busy,
  onCancel,
  onConfirm,
}: {
  maxRefund: bigint;
  meta: TokenMeta;
  amount: string;
  onAmountChange: (value: string) => void;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (amount: bigint) => void;
}) {
  const amountCheck = checkAmount(amount, meta.decimals);
  const maxRefundStroops = maxRefund;
  const usable = amountCheck.ok && amountCheck.stroops <= maxRefundStroops && amountCheck.stroops > 0n;

  return (
    <div className="mt-3 rounded-lg border border-edge p-3">
      <p className="text-sm font-medium">Issue a refund</p>
      <p className="mt-1 text-xs text-muted">
        Refund up to {formatAmount(maxRefundStroops, meta)} (what you received net of fees).
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <label className="label" htmlFor="refund-amount">
            Amount ({meta.symbol})
          </label>
          <input
            id="refund-amount"
            className="input"
            inputMode="decimal"
            placeholder={fromStroops(maxRefundStroops, 4, meta.decimals)}
            value={amount}
            onChange={(e) => onAmountChange(e.target.value)}
            aria-invalid={!amountCheck.ok || amountCheck.stroops > maxRefundStroops}
            aria-describedby={amountCheck.ok ? undefined : "refund-amount-error"}
            disabled={busy}
          />
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !usable}
          onClick={() => {
            if (!amountCheck.ok) return;
            onConfirm(amountCheck.stroops);
          }}
        >
          {busy ? "Refunding…" : "Confirm refund"}
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>

      {!amountCheck.ok && (
        <p id="refund-amount-error" className="mt-2 text-sm text-danger">
          {amountCheck.message}
        </p>
      )}
      {amountCheck.ok && amountCheck.stroops > maxRefundStroops && (
        <p id="refund-amount-error" className="mt-2 text-sm text-danger">
          Refund cannot exceed {formatAmount(maxRefundStroops, meta)}.
        </p>
      )}
    </div>
  );
}

export default function MerchantPage() {
  const { address, networkMismatch, signXdr, connect, connecting } = useWallet();
  const [plans, setPlans] = useState<ApiPlan[] | null>(null);
  const [mandates, setMandates] = useState<ApiMandate[] | null>(null);
  const [unpaidMandates, setUnpaidMandates] = useState<import("@/lib/chain").UnpaidMandate[] | null>(null);
  const [subscribersTab, setSubscribersTab] = useState<"all" | "unpaid">("all");
  const [summary, setSummary] = useState<MerchantSummary | null>(null);
  /**
   * Per-plan performance stats keyed by plan id.
   *
   * A missing key means the fetch has not returned yet (loading).
   * `null` means neither the API nor the contract could supply the data —
   * the stats block is hidden entirely.
   * `{ subscriber_count }` alone (no `total_collected`) means only the
   * contract's open-mandate counter was available; charge history requires
   * the indexer, so Collected and Cancellations stay hidden.
   * A full object means the backend supplied all three figures.
   */
  const [planStats, setPlanStats] = useState<
    Record<number, { subscriber_count: number; total_collected?: string; cancellations?: number } | null>
  >({});
  // Vault balance per subscriber address, read in parallel with mandates.
  const [balances, setBalances] = useState<Record<string, bigint | null>>({});
  const [exporting, setExporting] = useState(false);
  const [feeBps, setFeeBps] = useState<number | null>(null);
  const [bucketSize, setBucketSize] = useState<BucketSize>("day");
  /**
   * null while loading or when the backend cannot serve the endpoint; the
   * chart is hidden with an explanation rather than drawn as an empty box, so
   * "no data" and "no data source" never look the same.
   */
  const [revenue, setRevenue] = useState<RevenuePoint[] | null>(null);
  const [revenueUnavailable, setRevenueUnavailable] = useState(false);

  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [priceTouched, setPriceTouched] = useState(false);
  // The period picker's two halves: which preset (or "Custom…"), and — only
  // when Custom is chosen — how many of which unit. The contract stores
  // seconds, so a fortnight is entered as "2 weeks" and becomes 1_209_600
  // here, never as a raw second count the merchant would have to calculate.
  const [periodPreset, setPeriodPreset] = useState<string>(String(DEFAULT_PERIOD));
  const [periodCount, setPeriodCount] = useState("");
  const [periodUnit, setPeriodUnit] = useState("day");
  const [trial, setTrial] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  // Ending is permanent, so the End button asks for a second click.
  const [confirmEnd, setConfirmEnd] = useState<number | null>(null);
  // Pausing is reversible, so the Pause button asks for a second click
  // when the merchant is pausing (not resuming).
  const [confirmPause, setConfirmPause] = useState<number | null>(null);
  // Deactivating a plan asks for confirmation and displays open mandate impact.
  const [confirmDeactivate, setConfirmDeactivate] = useState<number | null>(null);
  // Embed snippet code view for plan.
  const [embedFor, setEmbedFor] = useState<number | null>(null);
  const { priceData: xlmPrice } = useXlmUsdPrice();
  /**
   * The mandate whose discount form is open. One at a time: the form carries
   * two fields, and a page full of them is unreadable.
   */
  const [discountFor, setDiscountFor] = useState<number | null>(null);
  /**
   * The mandate whose refund form is open. One at a time: the form carries
   * an amount field, and a page full of them is unreadable.
   */
  const [refundFor, setRefundFor] = useState<number | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  /**
   * Whether the deployed contract can carry a discount at all.
   *
   * The control is hidden until it can: calling a method the contract does
   * not have fails every transaction, and a merchant who sees a discount
   * button that cannot work has been misled.
   */
  const [discountSupport, setDiscountSupport] = useState(false);

  /**
   * Whether the deployed contract supports merchant-initiated pauses.
   *
   * The control is hidden until it can: the contract must have the
   * `set_paused` method (which it does on all deployments) and the
   * mandate must carry `pause_until` to know if it's paused by the merchant.
   * We check the first mandate to determine support.
   */
  const [pauseSupport, setPauseSupport] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Track who paused each mandate: "subscriber" | "merchant" | undefined
  // Updated by the SSE stream when available.
  const [pausedBy, setPausedBy] = useState<Map<number, "subscriber" | "merchant">>(new Map());

  const tokens: readonly ConfiguredToken[] =
    (config as unknown as { tokens?: ConfiguredToken[] }).tokens ?? DEFAULT_TOKENS;

  const [selectedToken, setSelectedToken] = useState(
    config.contracts.token || tokens[0]?.id || "",
  );

  // Plans can be published in any configured token; mandates carry their own.
  const metas = useTokenMetas([
    config.contracts.token,
    selectedToken,
    ...tokens.map((t) => t.id),
    ...(plans ?? []).map((p) => p.token),
    ...(mandates ?? []).map((m) => m.token ?? config.contracts.token),
  ]);
  const tokenMeta = metaFor(metas, selectedToken);

  // The contract rejects a name over MAX_NAME_LEN bytes, so catch it here
  // rather than letting the user pay for a transaction that will fail.
  const nameTooLong = nameByteLength(name.trim()) > MAX_NAME_LEN;
  // Same reasoning for the price: a bad one only fails once the wallet has
  // already opened, so the form says so up front and keeps Publish disabled.
  // The message waits for a first keystroke — an untouched empty field is not
  // an error, and saying so the moment the page loads reads as an accusation.
  // The field is checked against the publish token's decimals, not a hardcoded
  // 7: a SEP-41 token picks its own scale.
  const priceCheck = checkAmount(price, tokenMeta.decimals);
  const priceError = priceCheck.ok ? null : priceCheck.message;
  const showPriceError = priceError !== null && (priceTouched || price.trim() !== "");
  const split = priceCheck.ok ? feeSplit(priceCheck.stroops, feeBps ?? 0) : null;
  const trialSupported = (plans ?? []).some(supportsTrials);
  // One check covers both halves of the picker: presets go through the same
  // contract rules as a custom value, so nothing reaches `create_plan` that
  // the chain would reject — and a custom period can never be published while
  // its count is empty, unreadable, or below the 60-second floor.
  const customPeriod = periodPreset === CUSTOM_PERIOD;
  const periodCheck: PeriodCheck = customPeriod
    ? checkCustomPeriod(periodCount, periodUnit)
    : checkPeriodSeconds(Number(periodPreset));
  // Unlike the price, this message appears the moment Custom is chosen, with
  // no "wait until touched": that rule exists for a field that is empty the
  // instant the page loads, while a custom count only exists once the
  // merchant has asked for one — so the gap is theirs to fill, said plainly.
  const periodError = periodCheck.ok ? null : periodCheck.message;

  const load = useCallback(async () => {
    if (!address) return;
    const [p, m, s] = await Promise.all([
      api.plans(address),
      api.mandatesFor(address),
      api.merchantSummary(address),
    ]);

    let loadedPlans: ApiPlan[] = [];
    if (p) {
      setPlans(p.plans);
      loadedPlans = p.plans;
    } else {
      try {
        loadedPlans = await chainPlansOf(address, address);
        setPlans(loadedPlans);
      } catch {
        setPlans([]);
      }
    }

    let rows: ApiMandate[] = [];
    if (m) {
      rows = m.mandates;
    } else {
      try {
        rows = await chainMandatesFor(address, address);
      } catch {
        rows = [];
      }
    }
    setMandates(rows);

    // Load unpaid mandates
    const unpaidResponse = await api.unpaidMandates(address);
    if (unpaidResponse && unpaidResponse.unpaid) {
      // Backend provided unpaid list, convert to UnpaidMandate format
      const now = Math.floor(Date.now() / 1000);
      const unpaidList: UnpaidMandate[] = await Promise.all(
        unpaidResponse.unpaid.map(async (mandate) => {
          try {
            const amount = BigInt(mandate.amount);
            const balance = await payflow.vaultBalance(address, mandate.subscriber, mandate.token ?? config.contracts.token);
            const shortfall = balance !== null && amount > balance ? amount - balance : 0n;
            return {
              mandate,
              shortfall,
              overdueDuration: now - mandate.next_charge,
            };
          } catch {
            // If vault balance read fails, estimate from mandate being in unpaid list
            return {
              mandate,
              shortfall: BigInt(mandate.amount),
              overdueDuration: now - mandate.next_charge,
            };
          }
        })
      );
      setUnpaidMandates(unpaidList.filter(u => u.shortfall > 0n));
    } else {
      // Fallback to contract-only mode
      try {
        const unpaidList = await chainUnpaidMandates(address, address);
        setUnpaidMandates(unpaidList);
      } catch {
        setUnpaidMandates([]);
      }
    }

    // Revenue totals come from charge history, which only the indexer has.
    setSummary(s ?? chainMerchantSummary(address, rows));

    // Per-plan stats: try the backend first; fall back to the contract for
    // the subscriber count only (total_collected and cancellations require
    // charge history which only the indexer holds).
    if (loadedPlans.length > 0) {
      void Promise.all(
        loadedPlans.map(async (plan) => {
          const apiStats = await api.planStats(plan.id);
          if (apiStats !== null) {
            setPlanStats((prev) => ({ ...prev, [plan.id]: apiStats }));
            return;
          }
          // API unavailable: read subscriber count from contract state if
          // the contract supports it. total_collected and cancellations are
          // not derivable from chain alone, so they stay absent and the UI
          // hides them.
          const count = await chainPlanSubscriberCount(address, plan.id);
          setPlanStats((prev) => ({
            ...prev,
            [plan.id]: count !== null ? { subscriber_count: count } : null,
          }));
        }),
      );
    }

    // Read each subscriber's vault balance in parallel so the dashboard can
    // flag mandates that will fail. Individual reads may fail without breaking
    // the whole list.
    const subscribers = [...new Set(rows.map((m) => m.subscriber))];
    const settled = await Promise.allSettled(
      subscribers.map((sub) => payflow.vaultBalance(address, sub, config.contracts.token)),
    );
    const b: Record<string, bigint | null> = {};
    subscribers.forEach((sub, i) => {
      if (settled[i]?.status === "fulfilled") b[sub] = settled[i].value;
    });
    setBalances(b);
  }, [address]);

  // SSE stream for live updates (payflow-backend#19)
  useStream({
    address,
    role: "merchant",
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
    void load();
  }, [load]);

  /**
   * Whether the deployed contract can carry a discount.
   *
   * The rows are enough when they came from the contract, but the indexer
   * does not project the discount yet, so one mandate is read from the chain
   * to answer the question the same way in both modes.
   */
  useEffect(() => {
    const row = mandates?.[0];
    if (!address || !row) {
      setDiscountSupport(false);
      return;
    }
    if (supportsDiscounts(row)) {
      setDiscountSupport(true);
      return;
    }
    let live = true;
    void payflow
      .getMandate(address, row.id)
      .then((mandate) => {
        if (live) setDiscountSupport(supportsDiscounts(mandate));
      })
      .catch(() => {
        if (live) setDiscountSupport(false);
      });
    return () => {
      live = false;
    };
  }, [address, mandates]);

  /**
   * Whether the deployed contract supports refunds on mandates.
   *
   * The indexer does not project the refundable_amount yet, so one mandate
   * is read from the chain to answer the question the same way in both modes.
   */
  const [refundSupport, setRefundSupport] = useState(false);
  useEffect(() => {
    const row = mandates?.[0];
    if (!address || !row) {
      setRefundSupport(false);
      return;
    }
    if (mandateSupportsRefund(row)) {
      setRefundSupport(true);
      return;
    }
    let live = true;
    void payflow
      .getMandate(address, row.id)
      .then((mandate) => {
        if (live) setRefundSupport(mandateSupportsRefund(mandate));
      })
      .catch(() => {
        if (live) setRefundSupport(false);
      });
    return () => {
      live = false;
    };
  }, [address, mandates]);

  /**
   * Whether the deployed contract supports merchant-initiated pauses.
   *
   * The indexer does not project pause_until yet, so one mandate
   * is read from the chain to answer the question the same way in both modes.
   */
  useEffect(() => {
    const row = mandates?.[0];
    if (!address || !row) {
      setPauseSupport(false);
      return;
    }
    // The contract has always had `set_paused`; what we need to know is
    // whether the mandate carries `pause_until` so we can distinguish
    // merchant pauses from subscriber pauses. If the field is present,
    // the control can be shown.
    if (mandatePauseUntil(row) !== null) {
      setPauseSupport(true);
      return;
    }
    let live = true;
    void payflow
      .getMandate(address, row.id)
      .then((mandate) => {
        if (live) setPauseSupport(mandatePauseUntil(mandate) !== null);
      })
      .catch(() => {
        if (live) setPauseSupport(false);
      });
    return () => {
      live = false;
    };
  }, [address, mandates]);

  // The shareable catalogue link, built after mount so the statically
  // prerendered markup (no window) and the hydrated one cannot disagree.
  const [publicUrl, setPublicUrl] = useState("");
  useEffect(() => {
    if (!address) return;
    setPublicUrl(
      `${window.location.origin}${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/m/?address=${address}`,
    );
  }, [address]);

  // Read once per wallet, not on every reload: the protocol fee only moves
  // when an admin changes it, and this is a preview rather than a gate — if the
  // read fails the form still publishes, it just shows a 0% split.
  useEffect(() => {
    if (!address) return;
    let live = true;
    void payflow
      .feeBps(address)
      .then((bps) => {
        if (live && Number.isFinite(bps)) setFeeBps(bps);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [address]);

  /**
   * Revenue over time, refetched when the granularity changes.
   *
   * 90 days covers a quarterly cycle, which is the longest window a daily
   * series stays readable at this width; weekly covers a year in the same
   * number of columns.
   */
  useEffect(() => {
    if (!address) return;
    let live = true;
    const now = Math.floor(Date.now() / 1000);
    const from = now - REVENUE_WINDOW_DAYS * 86_400;
    setRevenueUnavailable(false);
    void api
      .merchantRevenue(address, { bucket: bucketSize, from, to: now })
      .then((body) => {
        if (!live) return;
        const parsed = parseRevenue(body);
        if (parsed === null) {
          setRevenueUnavailable(true);
          setRevenue(null);
          return;
        }
        setRevenue(fillBuckets(parsed, bucketSize, from, now));
      })
      .catch(() => {
        if (live) setRevenueUnavailable(true);
      });
    return () => {
      live = false;
    };
  }, [address, bucketSize]);

  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setError(null);
    setDone(null);
    try {
      setDone(await fn());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  /** Gather every charge settled against the merchant's mandates and download it as CSV. */
  async function exportCsv() {
    setExporting(true);
    try {
      const dateCache = new Map<string, string>();
      async function chargeDate(txHash: string): Promise<string> {
        if (dateCache.has(txHash)) return dateCache.get(txHash)!;
        let date = "—";
        try {
          const tx = await server.getTransaction(txHash);
          // Only successful/failed transactions carry a creation timestamp.
          if ("createdAt" in tx) {
            const createdAt = tx.createdAt as number;
            const ms = createdAt > 1e12 ? createdAt : createdAt * 1000;
            date = new Date(ms).toISOString().slice(0, 10);
          }
        } catch {
          // Best-effort: contract-only mode or RPC failure leaves the date blank.
        }
        dateCache.set(txHash, date);
        return date;
      }

      const rows: ChargeRow[] = [];
      for (const m of mandates ?? []) {
        const res = await api.charges(m.id);
        if (!res) continue;
        for (const c of res.charges) {
          const amount = BigInt(c.amount);
          const fee = BigInt(c.fee);
          rows.push({
            date: await chargeDate(c.tx_hash),
            mandateId: c.mandate_id,
            subscriber: m.subscriber,
            gross: fromStroops(amount),
            fee: fromStroops(fee),
            net: fromStroops(amount - fee),
            txHash: c.tx_hash,
          });
        }
      }

      rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      const dates = rows.map((r) => r.date).filter((d) => d !== "—");
      const from = dates.length ? dates[0]! : "all";
      const to = dates.length ? dates[dates.length - 1]! : "all";

      downloadCsv(
        buildCsv(rows),
        exportFilename(address!, from, to),
      );
    } finally {
      setExporting(false);
    }
  }

  if (!address) {
    return (
      <Panel title="Merchant dashboard">
        <Empty
          title="No wallet connected"
          action={
            <button
              type="button"
              className="btn-primary"
              disabled={connecting}
              onClick={() => void connect()}
            >
              {connecting ? "Connecting…" : "Connect wallet"}
            </button>
          }
        >
          Connect the wallet that will publish plans. Plans, subscribers and
          revenue are all read for that address — on testnet, fund it with
          Friendbot before publishing.
        </Empty>
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      <MerchantChurnPanel
        key={address}
        merchant={address}
        apiConfigured={api.isConfigured()}
      />

      <Panel
        title="Revenue over time"
        subtitle={`Net of the protocol fee, over the last ${REVENUE_WINDOW_DAYS} days.`}
        actions={
          revenue !== null ? (
            <label className="flex items-center gap-2 text-sm text-muted">
              <span className="sr-only sm:not-sr-only">Group by</span>
              <select
                className="input w-auto py-1"
                value={bucketSize}
                onChange={(e) => setBucketSize(e.target.value as BucketSize)}
              >
                <option value="day">Day</option>
                <option value="week">Week</option>
              </select>
            </label>
          ) : undefined
        }
      >
        {revenueUnavailable ? (
          <Empty>
            Revenue history comes from the payflow indexer, which is not reachable
            here — so there is nothing to plot. The totals above still come from
            contract state; only the time series needs the backend.
          </Empty>
        ) : revenue === null ? (
          <SkeletonRows rows={2} label="Loading revenue" />
        ) : revenue.length === 0 ? (
          <Empty
            title="Nothing settled in this period"
            action={
              <a href="#publish-plan" className="btn-ghost">
                Publish a plan
              </a>
            }
          >
            A charge settles when a mandate falls due and the keeper — or you,
            with Charge now — collects it. Publish a plan and share your public
            page to get your first subscriber.
          </Empty>
        ) : (
          <RevenueChart points={revenue} size={bucketSize} meta={tokenMeta} />
        )}
      </Panel>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Collected"
          loading={summary === null}
          value={
            summary?.totalCollected
              ? fromStroops(summary.totalCollected, 4, tokenMeta.decimals)
              : "—"
          }
          hint={`${tokenMeta.symbol}, net of protocol fee`}
        />
        <Stat
          label="Active mandates"
          loading={summary === null}
          value={summary?.activeMandates ?? "—"}
        />
        <Stat
          label="Charges settled"
          loading={summary === null}
          value={summary?.chargeCount ?? "—"}
        />
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {done && (
        <Notice tone="ok">
          Done. Transaction <TxLink hash={done} />
        </Notice>
      )}

      {/* id is the anchor target for the empty states below. */}
      <Panel
        id="publish-plan"
        title="Publish a plan"
        subtitle="Price and period are frozen into every mandate opened against this plan. To change them, publish a new plan."
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[8rem] flex-1">
            <label className="label" htmlFor="plan-token">
              Token
            </label>
            <select
              id="plan-token"
              className="input"
              value={selectedToken}
              onChange={(e) => setSelectedToken(e.target.value)}
              disabled={busy !== null}
            >
              {tokens.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.symbol} — {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[10rem] flex-1">
            <AmountInput
              id="price"
              label={`Price (${tokenMeta.symbol})`}
              value={price}
              onChange={(next) => {
                setPrice(next);
                setPriceTouched(true);
              }}
              onBlur={() => setPriceTouched(true)}
              decimals={tokenMeta.decimals}
              placeholder="1.0"
              disabled={busy !== null}
              // The form renders the price message in the fee-preview slot
              // below, so the field must not repeat it inline.
              hideError
              describedBy="price-preview"
            />
          </div>
          <div className="min-w-[12rem] flex-1">
            <label className="label" htmlFor="plan-name">
              Plan name
            </label>
            <input
              id="plan-name"
              className="input"
              placeholder="Pro Monthly"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={nameTooLong}
              aria-describedby={nameTooLong ? "plan-name-error" : undefined}
            />
            {nameTooLong && (
              <p id="plan-name-error" className="mt-1 text-sm text-danger">
                Too long — {MAX_NAME_LEN} bytes maximum.
              </p>
            )}
          </div>
          <div className="min-w-[10rem] flex-1">
            <label className="label" htmlFor="period">
              Billing period
            </label>
            <select
              id="period"
              className="input"
              value={periodPreset}
              onChange={(e) => setPeriodPreset(e.target.value)}
            >
              {PERIOD_PRESETS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              <option value={CUSTOM_PERIOD}>Custom…</option>
            </select>
          </div>
          {customPeriod && (
            // A sibling of the other fields, not a child of the picker: at
            // ~375px the picker shares its line with Publish, and a number +
            // unit pair cannot fit the ~160px the picker is allowed there. On
            // its own form row the pair keeps its width at every size, and
            // both controls keep visible labels — a placeholder is not a
            // label, and it disappears once typing starts.
            <div className="min-w-[16rem] flex-1">
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-28">
                  <label className="label" htmlFor="period-count">
                    Custom period
                  </label>
                  <input
                    id="period-count"
                    className="input"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    placeholder="14"
                    value={periodCount}
                    onChange={(e) => setPeriodCount(e.target.value)}
                    aria-invalid={periodError !== null}
                    aria-describedby={periodError !== null ? "period-error" : undefined}
                  />
                </div>
                <div className="w-28">
                  <label className="label" htmlFor="period-unit">
                    Unit
                  </label>
                  <select
                    id="period-unit"
                    className="input"
                    value={periodUnit}
                    onChange={(e) => setPeriodUnit(e.target.value)}
                  >
                    {PERIOD_UNITS.map((u) => (
                      <option key={u.name} value={u.name}>
                        {unitLabel(u)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {periodError && (
                <p id="period-error" className="mt-2 text-sm text-rose-200">
                  {periodError}
                </p>
              )}
            </div>
          )}
          {trialSupported && (
            <div className="min-w-[10rem] flex-1">
              <label className="label" htmlFor="trial">
                Free trial
              </label>
              <select
                id="trial"
                className="input"
                value={trial}
                onChange={(e) => setTrial(Number(e.target.value))}
              >
                <option value={0}>None</option>
                {TRIAL_OPTIONS.map((o) => (
                  <option key={o.seconds} value={o.seconds}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button
            type="button"
            className="btn-primary"
            disabled={
              busy !== null || networkMismatch || nameTooLong || !priceCheck.ok || !periodCheck.ok
            }
            onClick={() => {
              // Publish the amounts the form already parsed rather than
              // reading the fields again: a half-typed "1." passes
              // `checkAmount` but `toStroops` rejects, so re-parsing here
              // would throw on a click the form had just said was fine. The
              // period is the same — the button cannot be clicked with an
              // unchecked one, and this narrowing is the proof of that.
              if (!priceCheck.ok || !periodCheck.ok) return;
              void run("create", () =>
                payflow.createPlan(address, signXdr, {
                  token: selectedToken,
                  amount: priceCheck.stroops,
                  period: periodCheck.seconds,
                  name: name.trim(),
                  // Omitted, not zeroed, when unsupported: the deployed
                  // contract's create_plan takes five arguments and a sixth
                  // would fail every publish.
                  ...(trialSupported ? { trial } : {}),
                }),
              );
            }}
          >
            {busy === "create" ? "Publishing…" : "Publish plan"}
          </button>
        </div>

        <p
          id="price-preview"
          aria-live="polite"
          className={showPriceError ? "mt-3 text-sm text-danger" : "mt-3 text-sm text-muted"}
        >
          {showPriceError
            ? priceError
            : (split ? (
                <FeePreview
                  split={split}
                  feeBps={feeBps ?? 0}
                  meta={tokenMeta}
                  usdEstimate={
                    tokenMeta.symbol === "XLM" && xlmPrice
                      ? formatUsdEstimate(split.gross, xlmPrice.price, xlmPrice.decimals, tokenMeta.decimals)
                      : tokenMeta.symbol === "USDC"
                        ? formatUsdcEstimate(split.gross, tokenMeta.decimals)
                        : null
                  }
                />
              ) : null)}
        </p>
      </Panel>

      <Panel
        title="My plans"
        actions={
          <div className="flex items-center gap-2">
            <Link
              href={`/m/?address=${address}`}
              className="btn-ghost whitespace-nowrap"
            >
              Public page
            </Link>
            <CopyButton value={publicUrl} label="public page link" />
          </div>
        }
      >
        {plans === null ? (
          <SkeletonRows rows={2} label="Loading plans" />
        ) : plans.length === 0 ? (
          <Empty
            title="No plans yet"
            action={
              <a href="#publish-plan" className="btn-primary">
                Publish a plan
              </a>
            }
          >
            Use the form above to publish your first plan — it is written
            straight to the contract, so it works with or without the indexer.
            Subscribers can open a mandate against it as soon as it confirms.
          </Empty>
        ) : (
          <VirtualList
            items={plans}
            threshold={100}
            itemHeight={180}
            keyExtractor={(p) => p.id}
            listAriaLabel="Plans"
            className="space-y-3"
            renderItem={(p) => {
              const meta = metaFor(metas, p.token);
              const stats = planStats[p.id];
              // stats === undefined → still loading (key absent from the map)
              // stats === null      → stat source could not supply data; hide
              const statsLoading = !(p.id in planStats);
              // total_collected and cancellations require charge history, which
              // only the indexer holds. They are absent when the stats came
              // from the contract fallback, so the UI hides them rather than
              // show misleading zeros.
              const hasRevenue = stats?.total_collected !== undefined;
              const openCount = countOpenMandates(p.id, mandates, stats?.subscriber_count);
              const usdEstimate =
                meta.symbol === "XLM" && xlmPrice
                  ? formatUsdEstimate(p.amount, xlmPrice.price, xlmPrice.decimals, meta.decimals)
                  : meta.symbol === "USDC"
                    ? formatUsdcEstimate(p.amount, meta.decimals)
                    : null;
              return (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-edge p-4"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{p.name || `Plan #${p.id}`}</span>
                      <Badge status={p.active ? "Active" : "Paused"} />
                      {trialBadge(p) && (
                        <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                          {trialBadge(p)}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-sm text-muted">
                      {fromStroops(p.amount, 4, meta.decimals)} {meta.symbol}{" "}
                      {usdEstimate && (
                        <span
                          className="tabular-nums"
                          title="Estimated USD value via Reflector oracle"
                          aria-label={`Approximately ${usdEstimate} US Dollars`}
                        >
                          (≈ {usdEstimate}){" "}
                        </span>
                      )}
                      {formatPeriod(p.period)}
                    </div>
                    {/* Per-plan stats: subscriber count always shown when
                        readable; total collected and cancellations only when
                        the indexer supplied them (charge history needs the
                        backend). Hidden entirely when neither the API nor the
                        contract can supply a subscriber count. */}
                    {statsLoading ? (
                      <div
                        className="mt-2 flex flex-wrap gap-4 text-xs text-muted"
                        aria-busy="true"
                        role="status"
                      >
                        <span className="sr-only">Loading plan stats…</span>
                        <span className="h-4 w-20 rounded bg-white/10 motion-safe:animate-pulse" aria-hidden="true" />
                        <span className="h-4 w-24 rounded bg-white/10 motion-safe:animate-pulse" aria-hidden="true" />
                        <span className="h-4 w-20 rounded bg-white/10 motion-safe:animate-pulse" aria-hidden="true" />
                      </div>
                    ) : stats ? (
                      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                        <div className="flex gap-1">
                          <dt>Subscribers</dt>
                          <dd className="font-medium text-foreground tabular-nums">
                            {stats.subscriber_count}
                          </dd>
                        </div>
                        {hasRevenue && (
                          <>
                            <div className="flex gap-1">
                              <dt>Collected</dt>
                              <dd className="font-medium text-foreground tabular-nums">
                                {fromStroops(stats.total_collected!, 4, meta.decimals)}{" "}
                                {meta.symbol}
                              </dd>
                            </div>
                            <div className="flex gap-1">
                              <dt>Cancellations</dt>
                              <dd className="font-medium text-foreground tabular-nums">
                                {stats.cancellations!}
                              </dd>
                            </div>
                          </>
                        )}
                      </dl>
                    ) : null}
                  </div>
                  {confirmDeactivate === p.id ? (
                    <div
                      className="w-full mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
                      role="alert"
                      aria-live="polite"
                    >
                      <div className="font-medium text-amber-200">
                        Confirm plan deactivation
                      </div>
                      <p className="mt-1 text-xs text-muted">
                        This plan has{" "}
                        <strong className="text-foreground font-semibold">
                          {openCount === 1 ? "1 open subscription" : `${openCount} open subscriptions`}
                        </strong>
                        . Existing subscribers will continue to be billed on schedule until their subscriptions are individually ended or cancelled. New subscribers will no longer be able to subscribe to this plan.
                      </p>
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          disabled={busy !== null}
                          onClick={() => setConfirmDeactivate(null)}
                        >
                          Keep active
                        </button>
                        <button
                          type="button"
                          className="btn-primary text-xs"
                          disabled={busy !== null || networkMismatch}
                          onClick={() =>
                            void run(`toggle-${p.id}`, () =>
                              payflow.setPlanActive(address, signXdr, p.id, false),
                            ).then(() => setConfirmDeactivate(null))
                          }
                        >
                          {busy === `toggle-${p.id}` ? "Deactivating…" : "Confirm: deactivate"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        onClick={() => setEmbedFor(embedFor === p.id ? null : p.id)}
                        aria-expanded={embedFor === p.id}
                        aria-label={`Embed snippet for plan ${p.name || `#${p.id}`}`}
                      >
                        {embedFor === p.id ? "Close embed" : "Embed"}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={busy !== null || networkMismatch}
                        onClick={() => {
                          if (p.active) {
                            setConfirmDeactivate(p.id);
                          } else {
                            void run(`toggle-${p.id}`, () =>
                              payflow.setPlanActive(address, signXdr, p.id, true),
                            );
                          }
                        }}
                      >
                        {p.active ? "Deactivate" : "Activate"}
                      </button>
                    </div>
                  )}
                  {embedFor === p.id && (
                    <div className="w-full mt-3 rounded-lg border border-edge bg-surface/50 p-3 text-xs space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-foreground">Embed on your website</span>
                        <button
                          type="button"
                          className="btn-ghost text-xs py-0.5 px-2"
                          onClick={() => setEmbedFor(null)}
                        >
                          Close
                        </button>
                      </div>
                      <p className="text-muted">
                        Add this snippet to any HTML website. Subscribers can click it to subscribe in a secure popup window.
                      </p>
                      <pre className="overflow-x-auto rounded border border-edge bg-background p-2 font-mono text-[11px] text-muted">
                        <code>{`<script src="${typeof window !== "undefined" ? window.location.origin : ""}/payflow-frontend/embed/payflow-embed.js" defer></script>\n<payflow-button\n  plan-id="${p.id}"\n  merchant="${address}"\n  name="${p.name || `Plan #${p.id}`}"\n  amount="${fromStroops(p.amount, 4, meta.decimals)} ${meta.symbol}"\n  period="${formatPeriod(p.period)}">\n</payflow-button>`}</code>
                      </pre>
                      <CopyButton
                        value={`<script src="${typeof window !== "undefined" ? window.location.origin : ""}/payflow-frontend/embed/payflow-embed.js" defer></script>\n<payflow-button plan-id="${p.id}" merchant="${address}" name="${p.name || `Plan #${p.id}`}" amount="${fromStroops(p.amount, 4, meta.decimals)} ${meta.symbol}" period="${formatPeriod(p.period)}"></payflow-button>`}
                        label="embed snippet"
                      />
                    </div>
                  )}
                </div>
              );
            }}
          />
        )}
      </Panel>

      <Panel
        title="Subscribers"
        subtitle={
          subscribersTab === "all"
            ? "Charging is permissionless — you can settle a due mandate yourself instead of waiting for the keeper."
            : "Active mandates where the subscriber's vault cannot cover the next charge."
        }
        actions={
          <div className="flex items-center gap-3">
            {/* Tab navigation */}
            <div className="flex rounded-lg border border-edge bg-surface/30" role="tablist" aria-label="Subscriber views">
              <button
                type="button"
                role="tab"
                aria-selected={subscribersTab === "all"}
                aria-controls="subscribers-all-panel"
                id="subscribers-all-tab"
                className={`px-3 py-1.5 text-sm font-medium transition-colors rounded-l-lg ${
                  subscribersTab === "all"
                    ? "bg-accent text-white"
                    : "text-muted hover:text-fg"
                }`}
                onClick={() => setSubscribersTab("all")}
              >
                All
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={subscribersTab === "unpaid"}
                aria-controls="subscribers-unpaid-panel"
                id="subscribers-unpaid-tab"
                className={`px-3 py-1.5 text-sm font-medium transition-colors rounded-r-lg ${
                  subscribersTab === "unpaid"
                    ? "bg-accent text-white"
                    : "text-muted hover:text-fg"
                }`}
                onClick={() => setSubscribersTab("unpaid")}
              >
                Unpaid
                {unpaidMandates && unpaidMandates.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-danger px-1.5 py-0.5 text-xs font-semibold text-white">
                    {unpaidMandates.length}
                  </span>
                )}
              </button>
            </div>
            {subscribersTab === "all" && (
              <button
                type="button"
                className="btn-ghost mono text-sm"
                disabled={exporting || mandates?.length === 0 || networkMismatch}
                onClick={() => void exportCsv()}
                aria-label="Export charges to CSV"
              >
                {exporting ? "Exporting…" : "Export CSV"}
              </button>
            )}
          </div>
        }
      >
        {/* All Subscribers Tab */}
        <div
          role="tabpanel"
          id="subscribers-all-panel"
          aria-labelledby="subscribers-all-tab"
          hidden={subscribersTab !== "all"}
        >
        {mandates === null ? (
          <SkeletonRows rows={3} label="Loading subscribers" />
        ) : mandates.length === 0 ? (
          <Empty
            title="No subscribers yet"
            action={
              publicUrl ? (
                <a
                  href={publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-primary"
                >
                  Open your public page
                </a>
              ) : undefined
            }
          >
            Share your public page link so anyone can open a mandate against
            your plans. New subscribers appear here with their vault funding at
            a glance.
          </Empty>
        ) : (
          <VirtualList
            items={mandates}
            threshold={100}
            itemHeight={160}
            keyExtractor={(m) => m.id}
            listAriaLabel="Subscribers"
            className="space-y-3"
            renderItem={(m) => {
              const due = m.status === "Active" && m.next_charge * 1000 <= Date.now();
              const meta = metaFor(metas, m.token ?? config.contracts.token);
              const balance = balances[m.subscriber] ?? null;
              const funding = mandateFunding(balance, BigInt(m.amount));
              const short = funding.status === "short";
              const badge = discountBadge(m);
              const remaining = remainingDiscountCharges(m);
              return (
                <div
                  key={m.id}
                  className="rounded-lg border border-edge p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/mandates/?id=${m.id}`}
                          className="font-medium hover:underline text-soft focus:outline-none focus:ring-1 focus:ring-accent rounded"
                        >
                          #{m.id}
                        </Link>
                        <AddressLink value={m.subscriber} />
                        <Badge status={m.status} />
                        {badge && (
                          <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                            {badge}
                          </span>
                        )}
                        {pauseSupport && m.status === "Paused" && (
                          <>
                            {pausedBy.get(m.id) === "merchant" && (
                              <span className="text-xs text-muted">paused by you</span>
                            )}
                            {pausedBy.get(m.id) === "subscriber" && (
                              <span className="text-xs text-muted">paused by subscriber</span>
                            )}
                            {/* Fallback when SSE hasn't told us yet: show generic pause indicator */}
                            {pausedBy.get(m.id) === undefined && m.pause_until !== undefined && (
                              <span className="text-xs text-muted">paused</span>
                            )}
                          </>
                        )}
                        {m.ended_by === "merchant" && (
                          <span className="text-xs text-muted">ended by you</span>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {fromStroops(m.amount, 4, meta.decimals)} {meta.symbol}{" "}
                        {formatPeriod(m.period)} · {m.charges_made} settled · next{" "}
                        {m.status === "Active" ? <TimeAgo value={m.next_charge} /> : "—"}
                      </div>
                      {badge && (
                        <div className="mt-1 text-xs text-accent">
                          Subscriber pays{" "}
                          {fromStroops(
                            discountedAmount(BigInt(m.amount), Number(m.discount_bps)),
                            4,
                            meta.decimals,
                          )}{" "}
                          {meta.symbol} while the discount runs
                          {remaining === null
                            ? ""
                            : remaining === 0
                              ? " — the discount has run out"
                              : ` — ${remaining} discounted charge${remaining === 1 ? "" : "s"} left`}
                          .
                        </div>
                      )}
                      <div className="mt-1 text-xs font-medium">
                        {balance === null ? (
                          <span className="text-muted">Vault balance —</span>
                        ) : short ? (
                          <span className="text-danger">
                            Short by {fromStroops(funding.shortfall)} {meta.symbol}
                          </span>
                        ) : (
                          <span className="text-accent">Funded</span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {due && (
                        <>
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={busy !== null || networkMismatch || short}
                            onClick={() =>
                              void run(`charge-${m.id}`, () =>
                                payflow.charge(address, signXdr, m.id),
                              )
                            }
                          >
                            {busy === `charge-${m.id}` ? "Charging…" : short ? "Short on funds" : "Charge now"}
                          </button>
                          {short && (
                            <span className="text-xs text-danger">
                              Subscriber vault short by {fromStroops(funding.shortfall)} {meta.symbol}
                            </span>
                          )}
                        </>
                      )}
{discountSupport && endable(m) && (
                          <button
                            type="button"
                            className="btn-ghost"
                            disabled={busy !== null || networkMismatch}
                            aria-expanded={discountFor === m.id}
                            onClick={() =>
                              setDiscountFor(discountFor === m.id ? null : m.id)
                            }
                          >
                            {discountFor === m.id ? "Close" : "Discount"}
                          </button>
                        )}
                        {pauseSupport && endable(m) && (
                          <>
                            {confirmPause === m.id ? (
                              <>
                                <button
                                  type="button"
                                  className="btn-ghost"
                                  disabled={busy !== null}
                                  onClick={() => setConfirmPause(null)}
                                >
                                  Keep
                                </button>
                                <button
                                  type="button"
                                  className={m.status === "Active" ? "btn-primary" : "btn-ghost"}
                                  disabled={busy !== null || networkMismatch}
                                  onClick={() =>
                                    void run(`pause-${m.id}`, () =>
                                      payflow.setPaused(address, signXdr, m.id, m.status === "Active"),
                                    ).then(() => setConfirmPause(null))
                                  }
                                >
                                  {busy === `pause-${m.id}`
                                    ? m.status === "Active"
                                      ? "Pausing…"
                                      : "Resuming…"
                                    : m.status === "Active"
                                      ? "Confirm: pause"
                                      : "Confirm: resume"}
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className={m.status === "Active" ? "btn-primary" : "btn-ghost"}
                                disabled={busy !== null || networkMismatch}
                                onClick={() => setConfirmPause(m.id)}
                                aria-label={m.status === "Active" ? `Pause subscription #${m.id}` : `Resume subscription #${m.id}`}
                              >
                                {m.status === "Active" ? "Pause" : "Resume"}
                              </button>
                            )}
                          </>
                        )}
                        {refundSupport && endable(m) && (
                          <button
                            type="button"
                            className="btn-ghost"
                            disabled={busy !== null || networkMismatch}
                            aria-expanded={refundFor === m.id}
                            onClick={() => {
                              if (refundFor === m.id) {
                                setRefundFor(null);
                                setRefundAmount("");
                              } else {
                                const maxRefund = mandateRefundableAmount(m);
                                if (maxRefund !== null) {
                                  setRefundAmount(fromStroops(maxRefund, 4, meta.decimals).replace(/[^0-9.]/g, ""));
                                }
                                setRefundFor(m.id);
                              }
                            }}
                          >
                            {refundFor === m.id ? "Close" : "Refund"}
                          </button>
                        )}
                        {endable(m) &&
                        (confirmEnd === m.id ? (
                        <>
                          <button
                            type="button"
                            className="btn-ghost"
                            disabled={busy !== null}
                            onClick={() => setConfirmEnd(null)}
                          >
                            Keep
                          </button>
                          <button
                            type="button"
                            className="btn-danger"
                            disabled={busy !== null || networkMismatch}
                            onClick={() =>
                              void run(`end-${m.id}`, () =>
                                payflow.endMandate(address, signXdr, m.id),
                              ).then(() => setConfirmEnd(null))
                            }
                          >
                            {busy === `end-${m.id}` ? "Ending…" : "Confirm: end for good"}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={busy !== null || networkMismatch}
                          onClick={() => setConfirmEnd(m.id)}
                          aria-label={`End subscription #${m.id}`}
                        >
                          End
                        </button>
                      ))}
                    </div>
                  </div>

                  {discountFor === m.id && (
                    <DiscountForm
                      amount={BigInt(m.amount)}
                      meta={meta}
                      busy={busy === `discount-${m.id}`}
                      onCancel={() => setDiscountFor(null)}
                      onApply={(bps, charges) =>
                        void run(`discount-${m.id}`, () =>
                          payflow.setDiscount(address, signXdr, m.id, bps, charges),
                        ).then(() => setDiscountFor(null))
                      }
                    />
                  )}
                  {refundFor === m.id && (
                    <RefundForm
                      maxRefund={mandateRefundableAmount(m) ?? 0n}
                      meta={meta}
                      amount={refundAmount}
                      onAmountChange={setRefundAmount}
                      busy={busy === `refund-${m.id}`}
                      onCancel={() => {
                        setRefundFor(null);
                        setRefundAmount("");
                      }}
                      onConfirm={(amount) =>
                        void run(`refund-${m.id}`, () =>
                          payflow.refund(address, signXdr, m.id, amount),
                        ).then(() => {
                          setRefundFor(null);
                          setRefundAmount("");
                        })
                      }
                    />
                  )}
                </div>
              );
            }}
          />
        )}
        </div>

        {/* Unpaid Subscribers Tab */}
        <div
          role="tabpanel"
          id="subscribers-unpaid-panel"
          aria-labelledby="subscribers-unpaid-tab"
          hidden={subscribersTab !== "unpaid"}
        >
          {unpaidMandates === null ? (
            <SkeletonRows rows={2} label="Loading unpaid subscribers" />
          ) : unpaidMandates.length === 0 ? (
            <Empty title="All subscribers are funded">
              Every active mandate due for charging has sufficient vault balance.
              Subscribers with insufficient funds will appear here.
            </Empty>
          ) : (
            <div className="space-y-3">
              {unpaidMandates.map((unpaid) => {
                const m = unpaid.mandate;
                const meta = metaFor(metas, m.token ?? config.contracts.token);
                const badge = discountBadge(m);
                const overdueHours = Math.floor(unpaid.overdueDuration / 3600);
                const overdueDays = Math.floor(unpaid.overdueDuration / 86400);
                const overdueText =
                  overdueDays > 0
                    ? `${overdueDays} day${overdueDays === 1 ? "" : "s"}`
                    : overdueHours > 0
                      ? `${overdueHours} hour${overdueHours === 1 ? "" : "s"}`
                      : "less than 1 hour";
                return (
                  <div
                    key={m.id}
                    className="rounded-lg border border-danger/40 bg-danger/5 p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/mandates/?id=${m.id}`}
                            className="font-medium hover:underline text-soft focus:outline-none focus:ring-1 focus:ring-accent rounded"
                          >
                            #{m.id}
                          </Link>
                          <AddressLink value={m.subscriber} />
                          <Badge status={m.status} />
                          {badge && (
                            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                              {badge}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-sm text-muted">
                          {fromStroops(m.amount, 4, meta.decimals)} {meta.symbol}{" "}
                          {formatPeriod(m.period)} · {m.charges_made} settled
                        </div>
                        <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                            <div className="text-sm">
                              <span className="font-medium text-danger">
                                Short by {fromStroops(unpaid.shortfall, 4, meta.decimals)} {meta.symbol}
                              </span>
                            </div>
                            <div className="text-xs text-muted">
                              Overdue for {overdueText}
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <CopyButton value={m.subscriber} label="subscriber address" />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Panel>

      <WebhooksPanel key={`webhooks:${address}`} merchant={address} apiConfigured={api.isConfigured()} />
    </div>
  );
}
