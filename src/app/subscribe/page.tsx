"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, type ApiPlan } from "@/lib/api";
import { chainPlans } from "@/lib/chain";
import { config } from "@/lib/config";
import { payflow } from "@/lib/payflow";
import { useWallet } from "@/lib/wallet";
import {
  formatAmount,
  formatDate,
  formatWhen,
  formatPeriod,
  fromStroops,
  type TokenMeta,
} from "@/lib/format";
import { formatTrialLength, trialBadge, trialSeconds } from "@/lib/trial";
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
function seatsLabel(plan: ApiPlan, now: number): string {
  const availability = planAvailability(plan, now);
  if (availability.seats !== null) {
    return `${availability.seats} ${availability.seats === 1 ? "seat" : "seats"} left`;
  }
  const cap = availabilityInteger(plan.max_subscribers);
  if (cap && cap > 0) return "Count unavailable";
  return "Unlimited";
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
  return (
    <div
      className="mt-3 overflow-x-auto rounded-lg border border-edge"
      tabIndex={0}
      role="region"
      aria-label="Plan comparison, scroll horizontally if needed"
    >
      <table className="w-full min-w-[34rem] border-collapse text-sm">
        <caption className="sr-only">
          Side-by-side comparison of {plans.length} selected plans
        </caption>
        <thead>
          <tr className="border-b border-edge bg-fg/5">
            <th scope="col" className="px-3 py-2 text-left font-medium text-muted">
              Feature
            </th>
            {plans.map((plan) => (
              <th key={plan.id} scope="col" className="px-3 py-2 text-left font-semibold">
                {plan.name || `Plan #${plan.id}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-edge/60">
            <th scope="row" className="px-3 py-2 text-left font-medium text-muted">
              Price
            </th>
            {plans.map((plan) => {
              const meta = metaFor(metas, plan.token);
              return (
                <td key={plan.id} className="px-3 py-2 tabular-nums">
                  {fromStroops(plan.amount, 4, meta.decimals)}{" "}
                  <span className="text-xs text-muted">{meta.symbol}</span>
                </td>
              );
            })}
          </tr>
          <tr className="border-b border-edge/60">
            <th scope="row" className="px-3 py-2 text-left font-medium text-muted">
              Billing period
            </th>
            {plans.map((plan) => (
              <td key={plan.id} className="px-3 py-2">
                {formatPeriod(plan.period)}
              </td>
            ))}
          </tr>
          <tr className="border-b border-edge/60">
            <th scope="row" className="px-3 py-2 text-left font-medium text-muted">
              Monthly equivalent
              <span className="block text-xs font-normal">30-day month</span>
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
            <th scope="row" className="px-3 py-2 text-left font-medium text-muted">
              Free trial
            </th>
            {plans.map((plan) => {
              const trial = trialSeconds(plan);
              return (
                <td key={plan.id} className="px-3 py-2">
                  {plan.trial === undefined
                    ? "Not reported"
                    : trial > 0
                      ? formatTrialLength(trial)
                      : "None"}
                </td>
              );
            })}
          </tr>
          <tr className="border-b border-edge/60">
            <th scope="row" className="px-3 py-2 text-left font-medium text-muted">
              Seats
            </th>
            {plans.map((plan) => (
              <td key={plan.id} className="px-3 py-2">
                {seatsLabel(plan, now)}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className="px-3 py-2 text-left font-medium text-muted">
              Merchant
            </th>
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
      setError("Connect a wallet first.");
      return;
    }
    if (networkMismatch) {
      setError("Switch your wallet to the correct network first.");
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
        throw new Error("Charge limit must be a whole number, or 0 for open-ended.");
      }
      const latest = (await load()).find((p) => p.id === plan.id);
      if (walletState.current.address !== address || walletState.current.networkMismatch) {
        throw new Error("Wallet changed. Check your wallet and try again.");
      }
      if (!latest || latest.active !== 1) throw new Error("This plan is no longer available.");
      const reason = planAvailability(latest).reason;
      if (reason) throw new Error(reason);
      const hash = await payflow.subscribe(
        address,
        async (xdr) => {
          if (walletState.current.address !== address || walletState.current.networkMismatch) {
            throw new Error("Wallet changed. Check your wallet and try again.");
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
        <h1 className="text-2xl font-semibold tracking-tight">Available plans</h1>
        <p className="mt-1 text-sm text-muted">
          Subscribing opens a mandate. Fund your vault on the{" "}
          <Link href="/account" className="text-accent hover:underline">
            account page
          </Link>{" "}
          or charges will fail for lack of balance.
        </p>
      </div>

      {direct && (
        <Notice tone="info">
          Reading plans directly from the contract — the indexer is not
          reachable, so this list is capped at the first 24 plans.
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {done && (
        <Notice tone="ok">
          Subscribed. Transaction <TxLink hash={done} />
          {doneTrial && (
            <>
              {" "}
              {doneTrial.plan} has a {formatTrialLength(doneTrial.seconds)} free trial, so your
              first charge is due {formatTrialLength(doneTrial.seconds)} from now — nothing is
              taken before then, and cancelling before then costs nothing.
            </>
          )}
        </Notice>
      )}

      {plans === null ? (
        <SkeletonPlanCards label="Loading plans" />
      ) : active.length === 0 ? (
        (plans ?? []).length === 0 ? (
          <Empty
            title="No plans yet"
            action={
              <Link href="/merchant" className="btn-primary">
                Publish a plan
              </Link>
            }
          >
            Nothing has been published on this deployment yet. Publish a plan
            from the merchant page — it is written straight to the contract, so
            it appears here with or without the indexer.
          </Empty>
        ) : (
          <Empty
            title="No active plans right now"
            action={
              <Link href="/merchant" className="btn-primary">
                Publish a plan
              </Link>
            }
          >
            Every plan on this list is deactivated, so there is nothing to
            subscribe to at the moment. Check back later, or publish your own
            plan from the merchant page.
          </Empty>
        )
      ) : (
        <div className="space-y-4">
          {/* Filter and Sort Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-edge bg-surface/50 p-3">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <label htmlFor="period-filter" className="text-sm font-medium text-muted">
                  Billing period:
                </label>
                <select
                  id="period-filter"
                  className="input py-1 px-2.5 text-sm"
                  value={period}
                  onChange={(e) => updateParams(sort, e.target.value as PlanPeriodOption)}
                >
                  <option value="all">All periods</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Annual</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label htmlFor="sort-select" className="text-sm font-medium text-muted">
                  Sort by:
                </label>
                <select
                  id="sort-select"
                  className="input py-1 px-2.5 text-sm"
                  value={sort}
                  onChange={(e) => updateParams(e.target.value as PlanSortOption, period)}
                >
                  <option value="newest">Newest first</option>
                  <option value="price_asc">Price: Low to High</option>
                  <option value="price_desc">Price: High to Low</option>
                  <option value="period_asc">Period: Short to Long</option>
                  <option value="period_desc">Period: Long to Short</option>
                </select>
              </div>
            </div>

            <span className="text-xs text-muted" aria-live="polite">
              Showing {filteredPlans.length} of {active.length} plans
            </span>
          </div>

          {compareIds.length > 0 && (
            <section
              className="rounded-lg border border-edge bg-surface/50 p-3"
              aria-label="Plan comparison"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted" role="status">
                  {compareIds.length} of {COMPARE_LIMIT} plans selected for comparison
                  {compareIds.length === COMPARE_LIMIT ? " (maximum)" : ""}.
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
                    {showComparison ? "Hide comparison" : "Compare plans"}
                  </button>
                  <button type="button" className="btn-ghost" onClick={clearComparison}>
                    Clear selection
                  </button>
                </div>
              </div>
              {comparedPlans.length < 2 && (
                <p className="mt-2 text-xs text-muted">
                  Select at least two plans to compare them side by side.
                </p>
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
              title="No plans match this filter"
              action={
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => updateParams("newest", "all")}
                >
                  Reset filters
                </button>
              }
            >
              No active subscription plans match the selected billing period.
            </Empty>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {filteredPlans.map((plan) => {
                const meta = metaFor(metas, plan.token);
                const badge = trialBadge(plan);
                const availability = planAvailability(plan, now);
                const usdEstimate =
                  meta.symbol === "XLM" && xlmPrice
                    ? formatUsdEstimate(plan.amount, xlmPrice.price, xlmPrice.decimals, meta.decimals)
                    : meta.symbol === "USDC"
                      ? formatUsdcEstimate(plan.amount, meta.decimals)
                      : null;
                const selectedForCompare = compareIds.includes(plan.id);
                return (
                  <Panel
                    key={plan.id}
                    title={plan.name || `Plan #${plan.id}`}
                    actions={
                      <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-1 py-1 text-sm text-muted">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-accent"
                          checked={selectedForCompare}
                          disabled={!selectedForCompare && compareIds.length >= COMPARE_LIMIT}
                          onChange={() => toggleCompare(plan.id)}
                          aria-label={`Compare ${plan.name || `Plan #${plan.id}`}`}
                        />
                        Compare
                      </label>
                    }
                  >
                    <div className="space-y-3">
                      <div>
                        <div className="flex flex-wrap items-baseline gap-2">
                          <div className="text-2xl font-semibold tabular-nums">
                            {fromStroops(plan.amount, 4, meta.decimals)}{" "}
                            <span className="text-sm font-normal text-muted">{meta.symbol}</span>
                          </div>
                          {usdEstimate && (
                            <span
                              className="text-sm text-muted tabular-nums"
                              title="Estimated USD value based on Reflector oracle price"
                              aria-label={`Approximately ${usdEstimate} US Dollars`}
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
                          <p className="mt-1 text-xs text-muted">
                            Nothing is charged for {formatTrialLength(trialSeconds(plan))}. You can
                            cancel any time before the first charge and pay nothing.
                          </p>
                        )}
                      </div>

                      {availability.until !== null && (
                        <p className="text-sm text-muted">
                          Available until{" "}
                          <time dateTime={new Date(availability.until * 1000).toISOString()}>
                            {formatDate(availability.until)} ({formatWhen(availability.until, now * 1000)})
                          </time>
                        </p>
                      )}
                      {availability.seats !== null && (
                        <p className="text-sm text-accent">
                          {availability.seats} {availability.seats === 1 ? "seat" : "seats"} left
                        </p>
                      )}
                      {availability.countUnavailable && (
                        <p className="text-sm text-muted">
                          Remaining seats are unavailable from this source. Availability is checked by the
                          contract when subscribing.
                        </p>
                      )}
                      {availability.reason && (
                        <p id={`availability-${plan.id}`} className="text-sm text-muted">
                          {availability.reason}
                        </p>
                      )}

                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="text-muted">Merchant</span>
                        <MerchantAccount value={plan.merchant} />
                      </div>

                      <div>
                        <label className="label" htmlFor={`limit-${plan.id}`}>
                          Charge limit (0 = open-ended)
                        </label>
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
                          ? "Confirming…"
                          : networkMismatch
                          ? "Wrong network"
                          : address
                          ? "Subscribe"
                          : "Connect wallet"}
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
  return (
    <Suspense fallback={<SkeletonPlanCards label="Loading plans" />}>
      <SubscribeInner />
    </Suspense>
  );
}
