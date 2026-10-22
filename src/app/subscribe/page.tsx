"use client";

import { useI18n } from "@/i18n/provider";
import type { Translation } from "@/i18n/translate";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, type ApiPlan } from "@/lib/api";
import { chainPlans } from "@/lib/chain";
import { config } from "@/lib/config";
import { payflow } from "@/lib/payflow";
import { useWallet } from "@/lib/wallet";
import{ fromStroops, type TokenMeta } from "@/lib/format";
import { trialSeconds } from "@/lib/trial";
import { availabilityInteger, planAvailability } from "@/lib/availability";
import {
  COMPARE_LIMIT,
  planMonthlyEquivalent,
  plansForComparison,
  togglePlanComparison,
} from "@/lib/compare";
import { metaFor, useTokenMetas } from "@/lib/token";
import { filterAndSortPlans, type PlanPeriodOption, type PlanSortOption } from "@/lib/plans";
import { formatUsdEstimate, formatUsdcEstimate, useXlmUsdPrice } from "@/lib/price";
import { Empty, MerchantAccount, Notice, Panel, SkeletonPlanCards, TxLink } from "@/components/ui";

/** Remaining seats in words, without inventing a count the source cannot provide. */
function seatsLabel(plan: ApiPlan, now: number, tr: Translation): string {
  const availability = planAvailability(plan, now);
  if (availability.seats !== null) {
    return tr(availability.seats === 1 ? "{0} seat left" : "{0} seats left", { 0: availability.seats });
  }
  const cap = availabilityInteger(plan.max_subscribers);
  if (cap && cap > 0) return tr("Count unavailable");
  return tr("Unlimited");
}

/**
 * The comparison itself is a real table: plan names are column headers and
 * each attribute is a row header, so a screen reader announces "Price,
 * Monthly Software, 5 XLM" instead of an undifferentiated run of cells. The
 * scroll container is focusable and labelled for narrow screens, where the
 * three columns cannot fit without horizontal scrolling.
 */
function ComparisonTable({
  plans,
  metas,
  now,
}: {
  plans: ApiPlan[];
  metas: Map<string, TokenMeta>;
  now: number;
}) {
  const { t: tr, formatPeriod, formatAmount, formatTokenValue, formatTrialLength, formatNumber } = useI18n();
  return (
    <div
      className="mt-3 overflow-x-auto rounded-lg border border-edge"
      tabIndex={0}
      role="region"
      aria-label={tr("Plan comparison, scroll horizontally if needed")}
    >
      <table className="w-full min-w-[34rem] border-collapse text-sm">
        <caption className="sr-only">{tr("Side-by-side comparison of")}{" "}{formatNumber(plans.length)}{" "}{tr("selected plans")}</caption>
        <thead>
          <tr className="border-b border-edge bg-fg/5">
            <th scope="col" className="px-3 py-2 text-left font-medium text-muted">{tr("Feature")}</th>
            {plans.map((plan) => (
              <th key={plan.id} scope="col" className="px-3 py-2 text-left font-semibold">
                {plan.name ||tr("Plan #{0}", { "0": plan.id })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-edge/60">
            <th scope="row" className="px-3 py-2 text-left font-medium text-muted">{tr("Price")}</th>
            {plans.map((plan) => {
              const meta = metaFor(metas, plan.token);
              return (
                <td key={plan.id} className="px-3 py-2 tabular-nums">
                  {formatTokenValue(plan.amount, 4, meta.decimals)}{" "}
                  <span className="text-xs text-muted">{meta.symbol}</span>
                </td>
              );
            })}
          </tr>
          <tr className="border-b border-edge/60">
            <th scope="row" className="px-3 py-2 text-left font-medium text-muted">{tr("Billing period")}</th>
            {plans.map((plan) => (
              <td key={plan.id} className="px-3 py-2">
                {formatPeriod(plan.period)}
              </td>
            ))}
          </tr>
          <tr className="border-b border-edge/60">
            <th scope="row" className="px-3 py-2 text-left font-medium text-muted">{tr("Monthly equivalent")}<span className="block text-xs font-normal">{tr("30-day month")}</span>
            </th>
            {plans.map((plan) => {
              const meta = metaFor(metas, plan.token);
              const monthly = planMonthlyEquivalent(plan);
              return (
                <td key={plan.id} className="px-3 py-2 tabular-nums">
                  {monthly === null ? "—" : formatAmount(monthly, meta)}
                </td>
              );
            })}
          </tr>
          <tr className="border-b border-edge/60">
            <th scope="row" className="px-3 py-2 text-left font-medium text-muted">{tr("Free trial")}</th>
            {plans.map((plan) => {
              const trial = trialSeconds(plan);
              return (
                <td key={plan.id} className="px-3 py-2">
                  {plan.trial === undefined
                    ?tr("Not reported")
                    : trial > 0
                      ? formatTrialLength(trial)
                      :tr("None")}
                </td>
              );
            })}
          </tr>
          <tr className="border-b border-edge/60">
            <th scope="row" className="px-3 py-2 text-left font-medium text-muted">{tr("Seats")}</th>
            {plans.map((plan) => (
              <td key={plan.id} className="px-3 py-2">
                {seatsLabel(plan, now, tr)}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className="px-3 py-2 text-left font-medium text-muted">{tr("Merchant")}</th>
            {plans.map((plan) => (
              <td key={plan.id} className="px-3 py-2">
                <MerchantAccount value={plan.merchant} />
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function SubscribeInner() {
  const { t: tr, formatPeriod, formatDate, formatWhen, translateMessage, formatTrialLength, trialBadge, formatTokenValue, formatUsdString, formatNumber } = useI18n();
  const searchParams = useSearchParams();
  const sortParam = (searchParams?.get("sort") as PlanSortOption) || "newest";
  const periodParam = (searchParams?.get("period") as PlanPeriodOption) || "all";

  const [sort, setSort] = useState<PlanSortOption>(sortParam);
  const [period, setPeriod] = useState<PlanPeriodOption>(periodParam);
  // Plans ticked for the side-by-side table, in the order they were picked.
  const [compareIds, setCompareIds] = useState<number[]>([]);
  const [showComparison, setShowComparison] = useState(false);

  const { address, networkMismatch, signXdr } = useWallet();
  const [plans, setPlans] = useState<ApiPlan[] | null>(null);
  const [maxCharges, setMaxCharges] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [direct, setDirect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [doneTrial, setDoneTrial] = useState<{ plan: string; seconds: number } | null>(null);
  const { priceData: xlmPrice } = useXlmUsdPrice();

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const request = useRef(0);
  const walletState = useRef({ address, networkMismatch });
  // Mirrored in an effect: the wallet-changed guard is read from the signing
  // flow (event handler / async callback), never during render.
  useEffect(() => {
    walletState.current = { address, networkMismatch };
  }, [address, networkMismatch]);

  // Sync state if searchParams change externally
  useEffect(() => {
    if (searchParams) {
      const s = searchParams.get("sort") as PlanSortOption;
      if (s) setSort(s);
      const p = searchParams.get("period") as PlanPeriodOption;
      if (p) setPeriod(p);
    }
  }, [searchParams]);

  function updateParams(newSort: PlanSortOption, newPeriod: PlanPeriodOption) {
    setSort(newSort);
    setPeriod(newPeriod);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (newSort && newSort !== "newest") {
        url.searchParams.set("sort", newSort);
      } else {
        url.searchParams.delete("sort");
      }
      if (newPeriod && newPeriod !== "all") {
        url.searchParams.set("period", newPeriod);
      } else {
        url.searchParams.delete("period");
      }
      window.history.replaceState(null, "", url.toString());
    }
  }

  // Each plan can name a different token, so the cards read their own.
  const metas = useTokenMetas((plans ?? []).map((p) => p.token));

  const load = useCallback(async () => {
    const generation = ++request.current;
    const res = await api.plans();
    let loaded: ApiPlan[];
    try {
      loaded = res ? res.plans : await chainPlans(address ?? config.readSource);
    } catch {
      loaded = [];
    }
    if (generation === request.current) {
      setPlans(loaded);
      setDirect(!res);
    }
    return loaded;
  }, [address]);

  useEffect(() => {
    void load();
    const pending = request;
    return () => {
      pending.current++;
    };
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  async function subscribe(plan: ApiPlan) {
    if (!address) {
      setError(tr("Connect a wallet first."));
      return;
    }
    if (networkMismatch) {
      setError(tr("Switch your wallet to the correct network first."));
      return;
    }
    const blocked = planAvailability(plan).reason;
    if (blocked) {
      setError(blocked);
      return;
    }
    setBusy(plan.id);
    setError(null);
    setDone(null);
    try {
      const raw = maxCharges[plan.id]?.trim();
      const limit = raw ? Number(raw) : 0;
      if (!Number.isInteger(limit) || limit < 0) {
        throw new Error(tr("Charge limit must be a whole number, or 0 for open-ended."));
      }
      const latest = (await load()).find((p) => p.id === plan.id);
      if (walletState.current.address !== address || walletState.current.networkMismatch) {
        throw new Error(tr("Wallet changed. Check your wallet and try again."));
      }
      if (!latest || latest.active !== 1) throw new Error(tr("This plan is no longer available."));
      const reason = planAvailability(latest).reason;
      if (reason) throw new Error(reason);
      const hash = await payflow.subscribe(
        address,
        async (xdr) => {
          if (walletState.current.address !== address || walletState.current.networkMismatch) {
            throw new Error(tr("Wallet changed. Check your wallet and try again."));
          }
          const closed = planAvailability(latest).reason;
          if (closed) throw new Error(closed);
          return signXdr(xdr);
        },
        plan.id,
        limit,
      );
      setDone(hash);
      setDoneTrial(
        trialSeconds(plan) > 0
          ? { plan: plan.name || `Plan #${plan.id}`, seconds: trialSeconds(plan) }
          : null,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const active = useMemo(() => (plans ?? []).filter((p) => p.active === 1), [plans]);
  const filteredPlans = useMemo(() => {
    return filterAndSortPlans(active, { sort, period });
  }, [active, sort, period]);
  // Compare from the full active list rather than the filtered one: changing
  // the filter must not silently drop a column the subscriber already picked.
  const comparedPlans = useMemo(
    () => plansForComparison(active, compareIds),
    [active, compareIds],
  );

  function toggleCompare(planId: number) {
    const next = togglePlanComparison(compareIds, planId);
    setCompareIds(next);
    // A one-plan table is not a comparison; close it rather than leaving a
    // stale table on screen when the second plan is unticked.
    if (next.length < 2) setShowComparison(false);
  }

  function clearComparison() {
    setCompareIds([]);
    setShowComparison(false);
  }

  // A refresh can deactivate one of the selected plans; a table with one
  // column is not a comparison, so close it rather than leave it half full.
  useEffect(() => {
    if (comparedPlans.length < 2) setShowComparison(false);
  }, [comparedPlans.length]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{tr("Available plans")}</h1>
        <p className="mt-1 text-sm text-muted">{tr("Subscribing opens a mandate. Fund your vault on the")}{" "}
          <Link href="/account" className="text-accent hover:underline">{tr("account page")}</Link>{" "}{tr("or charges will fail for lack of balance.")}</p>
      </div>

      {direct && (
        <Notice tone="info">{tr("Reading plans directly from the contract — the indexer is not reachable, so this list is capped at the first 24 plans.")}</Notice>
      )}
      {error && <Notice tone="error">{translateMessage(error)}</Notice>}
      {done && (
        <Notice tone="ok">{tr("Subscribed. Transaction")}{" "}<TxLink hash={done} />
          {doneTrial && (
            <>
              {" "}
              {doneTrial.plan}{" "}{tr("has a")}{" "}{formatTrialLength(doneTrial.seconds)}{" "}{tr("free trial, so your first charge is due")}{" "}{formatTrialLength(doneTrial.seconds)}{" "}{tr("from now — nothing is taken before then, and cancelling before then costs nothing.")}</>
          )}
        </Notice>
      )}

      {plans === null ? (
        <SkeletonPlanCards label={tr("Loading plans")} />
      ) : active.length === 0 ? (
        (plans ?? []).length === 0 ? (
          <Empty
            title={tr("No plans yet")}
            action={
              <Link href="/merchant" className="btn-primary">{tr("Publish a plan")}</Link>
            }
          >{tr("Nothing has been published on this deployment yet. Publish a plan from the merchant page — it is written straight to the contract, so it appears here with or without the indexer.")}</Empty>
        ) : (
          <Empty
            title={tr("No active plans right now")}
            action={
              <Link href="/merchant" className="btn-primary">{tr("Publish a plan")}</Link>
            }
          >{tr("Every plan on this list is deactivated, so there is nothing to subscribe to at the moment. Check back later, or publish your own plan from the merchant page.")}</Empty>
        )
      ) : (
        <div className="space-y-4">
          {/* Filter and Sort Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-edge bg-surface/50 p-3">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <label htmlFor="period-filter" className="text-sm font-medium text-muted">{tr("Billing period:")}</label>
                <select
                  id="period-filter"
                  className="input py-1 px-2.5 text-sm"
                  value={period}
                  onChange={(e) => updateParams(sort, e.target.value as PlanPeriodOption)}
                >
                  <option value="all">{tr("All periods")}</option>
                  <option value="daily">{tr("Daily")}</option>
                  <option value="weekly">{tr("Weekly")}</option>
                  <option value="monthly">{tr("Monthly")}</option>
                  <option value="yearly">{tr("Annual")}</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label htmlFor="sort-select" className="text-sm font-medium text-muted">{tr("Sort by:")}</label>
                <select
                  id="sort-select"
                  className="input py-1 px-2.5 text-sm"
                  value={sort}
                  onChange={(e) => updateParams(e.target.value as PlanSortOption, period)}
                >
                  <option value="newest">{tr("Newest first")}</option>
                  <option value="price_asc">{tr("Price: Low to High")}</option>
                  <option value="price_desc">{tr("Price: High to Low")}</option>
                  <option value="period_asc">{tr("Period: Short to Long")}</option>
                  <option value="period_desc">{tr("Period: Long to Short")}</option>
                </select>
              </div>
            </div>

            <span className="text-xs text-muted" aria-live="polite">{tr("Showing")}{" "}{formatNumber(filteredPlans.length)}{" "}{tr("of")}{" "}{formatNumber(active.length)}{" "}{tr("plans")}</span>
          </div>

          {compareIds.length > 0 && (
            <section
              className="rounded-lg border border-edge bg-surface/50 p-3"
              aria-label={tr("Plan comparison")}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted" role="status">
                  {formatNumber(compareIds.length)}{" "}{tr("of")}{" "}{COMPARE_LIMIT}{" "}{tr("plans selected for comparison")}{compareIds.length === COMPARE_LIMIT ?tr(" (maximum)") : ""}.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={comparedPlans.length < 2}
                    aria-expanded={showComparison}
                    aria-controls="plan-comparison"
                    onClick={() => setShowComparison((open) => !open)}
                  >
                    {showComparison ?tr("Hide comparison") :tr("Compare plans")}
                  </button>
                  <button type="button" className="btn-ghost" onClick={clearComparison}>{tr("Clear selection")}</button>
                </div>
              </div>
              {comparedPlans.length < 2 && (
                <p className="mt-2 text-xs text-muted">{tr("Select at least two plans to compare them side by side.")}</p>
              )}
              {showComparison && comparedPlans.length >= 2 && (
                <div id="plan-comparison">
                  <ComparisonTable plans={comparedPlans} metas={metas} now={now} />
                </div>
              )}
            </section>
          )}

          {filteredPlans.length === 0 ? (
            <Empty
              title={tr("No plans match this filter")}
              action={
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => updateParams("newest", "all")}
                >{tr("Reset filters")}</button>
              }
            >{tr("No active subscription plans match the selected billing period.")}</Empty>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {filteredPlans.map((plan) => {
                const meta = metaFor(metas, plan.token);
                const badge = trialBadge(plan);
                const availability = planAvailability(plan, now);
                const usdEstimate =
                  meta.symbol === "XLM" && xlmPrice
                    ? formatUsdString(formatUsdEstimate(plan.amount, xlmPrice.price, xlmPrice.decimals, meta.decimals))
                    : meta.symbol === "USDC"
                      ? formatUsdString(formatUsdcEstimate(plan.amount, meta.decimals))
                      : null;
                const selectedForCompare = compareIds.includes(plan.id);
                return (
                  <Panel
                    key={plan.id}
                    title={plan.name ||tr("Plan #{0}", { "0": plan.id })}
                    actions={
                      <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-1 py-1 text-sm text-muted">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-accent"
                          checked={selectedForCompare}
                          disabled={!selectedForCompare && compareIds.length >= COMPARE_LIMIT}
                          onChange={() => toggleCompare(plan.id)}
                          aria-label={tr("Compare {0}", { "0": plan.name ||tr("Plan #{0}", { "0": plan.id }) })}
                        />{tr("Compare")}</label>
                    }
                  >
                    <div className="space-y-3">
                      <div>
                        <div className="flex flex-wrap items-baseline gap-2">
                          <div className="text-2xl font-semibold tabular-nums">
                            {formatTokenValue(plan.amount, 4, meta.decimals)}{" "}
                            <span className="text-sm font-normal text-muted">{meta.symbol}</span>
                          </div>
                          {usdEstimate && (
                            <span
                              className="text-sm text-muted tabular-nums"
                              title={tr("Estimated USD value based on Reflector oracle price")}
                              aria-label={tr("Approximately {0} US Dollars", { "0": usdEstimate })}
                            >
                              (≈ {usdEstimate})
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                          <span>{formatPeriod(plan.period)}</span>
                          {badge && (
                            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                              {badge}
                            </span>
                          )}
                        </div>
                        {badge && (
                          <p className="mt-1 text-xs text-muted">{tr("Nothing is charged for")}{" "}{formatTrialLength(trialSeconds(plan))}{tr(". You can cancel any time before the first charge and pay nothing.")}</p>
                        )}
                      </div>

                      {availability.until !== null && (
                        <p className="text-sm text-muted">{tr("Available until")}{" "}
                          <time dateTime={new Date(availability.until * 1000).toISOString()}>
                            {formatDate(availability.until)} ({formatWhen(availability.until, now * 1000)})
                          </time>
                        </p>
                      )}
                      {availability.seats !== null && (
                        <p className="text-sm text-accent">
                          {formatNumber(availability.seats)} {availability.seats === 1 ?tr("seat") :tr("seats")}{" "}{tr("left")}</p>
                      )}
                      {availability.countUnavailable && (
                        <p className="text-sm text-muted">{tr("Remaining seats are unavailable from this source. Availability is checked by the contract when subscribing.")}</p>
                      )}
                      {availability.reason && (
                        <p id={`availability-${plan.id}`} className="text-sm text-muted">
                          {translateMessage(availability.reason ?? "")}
                        </p>
                      )}

                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="text-muted">{tr("Merchant")}</span>
                        <MerchantAccount value={plan.merchant} />
                      </div>

                      <div>
                        <label className="label" htmlFor={`limit-${plan.id}`}>{tr("Charge limit (0 = open-ended)")}</label>
                        <input
                          id={`limit-${plan.id}`}
                          className="input"
                          inputMode="numeric"
                          placeholder="0"
                          value={maxCharges[plan.id] ?? ""}
                          onChange={(e) =>
                            setMaxCharges((m) => ({ ...m, [plan.id]: e.target.value }))
                          }
                        />
                      </div>

                      <button
                        type="button"
                        className="btn-primary w-full"
                        disabled={
                          busy !== null || !address || networkMismatch || availability.reason !== null
                        }
                        aria-describedby={availability.reason ? `availability-${plan.id}` : undefined}
                        onClick={(e) => {
                          e.stopPropagation();
                          void subscribe(plan);
                        }}
                      >
                        {busy === plan.id
                          ?tr("Confirming…")
                          : networkMismatch
                          ?tr("Wrong network")
                          : address
                          ?tr("Subscribe")
                          :tr("Connect wallet")}
                      </button>
                    </div>
                  </Panel>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SubscribePage() {
  const { t: tr } = useI18n();
  return (
    <Suspense fallback={<SkeletonPlanCards label={tr("Loading plans")} />}>
      <SubscribeInner />
    </Suspense>
  );
}
