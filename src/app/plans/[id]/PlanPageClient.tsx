"use client";

import { useI18n } from "@/i18n/provider";

import { notFound } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, type ApiMandate, type ApiPlan } from "@/lib/api";
import { chainMandatesFor, chainPlans, planChargeRow, type PlanCharge } from "@/lib/chain";
import { planAvailability } from "@/lib/availability";
import { config } from "@/lib/config";
import { payflow } from "@/lib/payflow";
import { useWallet } from "@/lib/wallet";
import{ fromStroops } from "@/lib/format";
import { AddressLink, Badge, Empty, Notice, Panel, TxLink } from "@/components/ui";

type ChargeRow = PlanCharge;

interface PlanPageClientProps {
  planId: string;
}

export function PlanPageClient({ planId }: PlanPageClientProps) {
  const { t: tr, formatPeriod, translateMessage, formatTokenValue } = useI18n();
  const { address, networkMismatch, signXdr } = useWallet();
  const wanted = Number(planId);
  const [plan, setPlan] = useState<ApiPlan | null>(null);
  const [charges, setCharges] = useState<ChargeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [direct, setDirect] = useState(false);
  const [maxCharges, setMaxCharges] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const walletState = useRef({ address, networkMismatch });
  // Mirrored in an effect: only the signing flow reads it (event handler /
  // async callback), never render.
  useEffect(() => {
    walletState.current = { address, networkMismatch };
  }, [address, networkMismatch]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCharges([]);
    if (!Number.isFinite(wanted)) {
      setLoading(false);
      return;
    }
    try {
      let plan: ApiPlan | null = null;
      let direct = false;
      const plansRes = await api.plans();
      if (plansRes) {
        plan = plansRes.plans.find((p) => p.id === wanted) ?? null;
      } else {
        // No indexer: enumerate straight from the registry.
        const fallback = await chainPlans(config.readSource);
        plan = fallback.find((p) => p.id === wanted) ?? null;
        direct = true;
      }
      setPlan(plan);
      setDirect(direct);

      if (plan) {
        let mandates: ApiMandate[] = [];
        const mandatesRes = await api.mandatesFor(plan.merchant);
        if (mandatesRes) {
          mandates = mandatesRes.mandates.filter((m) => m.plan_id === plan.id);
        } else {
          // No indexer: read mandates straight from the subscription contract.
          const fallback = await chainMandatesFor(config.readSource, plan.merchant);
          mandates = fallback.filter((m) => m.plan_id === plan.id);
        }
        const subscriberByMandate = new Map(mandates.map((m) => [m.id, m.subscriber]));
        const settled = await Promise.allSettled(mandates.map((m) => api.charges(m.id)));
        const rows: ChargeRow[] = [];
        for (const r of settled) {
          if (r.status === "fulfilled" && r.value) {
            for (const c of r.value.charges) {
              rows.push(planChargeRow(c, subscriberByMandate.get(c.mandate_id) ?? ""));
            }
          }
        }
        rows.sort((a, b) => b.ledger - a.ledger);
        setCharges(rows.slice(0, 20));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [wanted]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Panel title={tr("Plan")}>
        <Empty>{tr("Loading plan…")}</Empty>
      </Panel>
    );
  }

  if (!plan) {
    notFound();
  }

  // `notFound()` terminates rendering when the plan is missing, so `plan` is
  // non-null from here on.
  const subscribePlanId = plan.id;
  const unavailable = plan.active !== 1
    ? "This plan is closed to new subscriptions."
    : planAvailability(plan, now).reason;

  async function subscribe() {
    if (!address) {
      setError(tr("Connect a wallet first."));
      return;
    }
    if (networkMismatch) {
      setError(tr("Switch your wallet to the correct network first."));
      return;
    }
    const blocked = unavailable || planAvailability(plan ?? {}).reason;
    if (blocked) {
      setError(blocked);
      return;
    }
    const limit = Number(maxCharges?.trim()) || 0;
    if (!Number.isInteger(limit) || limit < 0) {
      setError(tr("Charge limit must be a whole number, or 0 for open-ended."));
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await api.plans();
      const plans = res ? res.plans : await chainPlans(address);
      const latest = plans.find((p) => p.id === subscribePlanId);
      if (!latest || latest.active !== 1) throw new Error(tr("This plan is no longer available."));
      setPlan(latest);
      const check = () => {
        if (walletState.current.address !== address || walletState.current.networkMismatch) {
          throw new Error(tr("Wallet changed. Check your wallet and try again."));
        }
        const reason = planAvailability(latest).reason;
        if (reason) throw new Error(reason);
      };
      check();
      const hash = await payflow.subscribe(address, async (xdr) => {
        check();
        return signXdr(xdr);
      }, subscribePlanId, limit);
      setDone(hash);
      setMaxCharges("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {direct && (
        <Notice tone="info">{tr("Reading this plan directly from the contract — the indexer is not reachable, so charge history may be incomplete.")}</Notice>
      )}
      {error && <Notice tone="error">{translateMessage(error)}</Notice>}
      {done && (
        <Notice tone="ok">{tr("Subscribed. Transaction")}{" "}<TxLink hash={done} />
        </Notice>
      )}

      <Panel title={plan.name ||tr("Plan #{0}", { "0": plan.id })}>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="label">{tr("Price")}</label>
            <div className="text-2xl font-semibold tabular-nums">
              {formatTokenValue(plan.amount)}{" "}{tr("XLM")}</div>
          </div>
          <div>
            <label className="label">{tr("Billing period")}</label>
            <div className="text-sm text-muted">{formatPeriod(plan.period)}</div>
          </div>
          <div>
            <label className="label">{tr("Merchant")}</label>
            <AddressLink value={plan.merchant} />
          </div>
          <div>
            <label className="label">{tr("Status")}</label>
            <Badge status={plan.active === 1 ? "Active" : "Paused"} />
          </div>
        </div>
      </Panel>

      <Panel title={tr("Recent charges")}>
        {charges.length === 0 ? (
          <Empty>{tr("No charges settled against this plan yet.")}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-muted text-left">{tr("Mandate")}</th>
                  <th className="text-muted text-left">{tr("Subscriber")}</th>
                  <th className="text-muted text-right">{tr("Amount")}</th>
                  <th className="text-muted text-right">{tr("Fee")}</th>
                  <th className="text-muted text-right">{tr("Net")}</th>
                  <th className="text-muted text-left">{tr("Tx hash")}</th>
                </tr>
              </thead>
              <tbody>
                {charges.map((c) => (
                  <tr key={c.txHash} className="border-t border-edge">
                    <td className="py-2">{c.mandateId}</td>
                    <td className="py-2">
                      <AddressLink value={c.subscriber} />
                    </td>
                    <td className="py-2 text-right">{c.amount}{" "}{tr("XLM")}</td>
                    <td className="py-2 text-right">{c.fee}{" "}{tr("XLM")}</td>
                    <td className="py-2 text-right">{c.net}{" "}{tr("XLM")}</td>
                    <td className="py-2 text-right">
                      <TxLink hash={c.txHash} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={tr("Subscribe to this plan")}>
        <p className="text-sm text-muted">{tr("Open a mandate against this plan. Fund your vault on the")}{" "}
          <Link href="/account" className="text-accent hover:underline">{tr("account page")}</Link>{" "}{tr("first, or charges will fail for lack of balance.")}</p>
        {unavailable && <p id="plan-availability" className="text-sm text-muted">{unavailable}</p>}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[12rem] flex-1">
            <label className="label" htmlFor="plan-charge-limit">{tr("Charge limit (0 = open-ended)")}</label>
            <input
              id="plan-charge-limit"
              className="input"
              inputMode="numeric"
              placeholder="0"
              value={maxCharges}
              onChange={(e) => setMaxCharges(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !address || networkMismatch || unavailable !== null}
            aria-describedby={unavailable ? "plan-availability" : undefined}
            onClick={() => void subscribe()}
          >
            {busy
              ?tr("Confirming…")
              : networkMismatch
                ?tr("Wrong network")
                : address
                  ?tr("Subscribe")
                  :tr("Connect wallet")}
          </button>
        </div>
      </Panel>
    </div>
  );
}
