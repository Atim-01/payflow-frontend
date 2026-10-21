"use client";

import { useI18n } from "@/i18n/provider";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, type ApiCharge, type ApiMandate, type ApiPlan } from "@/lib/api";
import { chainMandate } from "@/lib/chain";
import { config } from "@/lib/config";
import { mandateStatus, payflow, type Plan } from "@/lib/payflow";
import { useWallet } from "@/lib/wallet";
import{ fromStroops } from "@/lib/format";
import { metaFor, useTokenMetas } from "@/lib/token";
import { discountBps, discountedAmount, remainingDiscountCharges } from "@/lib/discount";
import {
  AddressLink,
  Badge,
  Empty,
  Notice,
  Panel,
  SkeletonRows,
  Stat,
  TxLink,
} from "@/components/ui";

function MandateDetailsInner() {
  const { t: tr, formatPeriod, formatDate, formatAmount, translateMessage, formatTokenValue, formatNumber } = useI18n();
  const searchParams = useSearchParams();
  const idParam = searchParams?.get("id");
  const mandateId =
    idParam && Number.isInteger(Number(idParam)) && Number(idParam) > 0
      ? Number(idParam)
      : null;

  const { address, networkMismatch, signXdr } = useWallet();

  const [mandate, setMandate] = useState<ApiMandate | null>(null);
  const [plan, setPlan] = useState<ApiPlan | null>(null);
  const [charges, setCharges] = useState<ApiCharge[] | null>(null);
  const [chargesUnavailable, setChargesUnavailable] = useState(false);
  const [vaultBalance, setVaultBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const metas = useTokenMetas(mandate ? [mandate.token || config.contracts.token] : []);
  const tokenMeta = metaFor(metas, mandate?.token || config.contracts.token);

  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    if (!mandateId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const source = address ?? config.readSource;

    try {
      // 1. Fetch mandate from indexer or contract fallback
      let m: ApiMandate | null = null;
      if (api.isConfigured()) {
        try {
          m = await api.mandate(mandateId);
        } catch {
          // fallback to chain below
        }
      }
      if (!m) {
        m = await chainMandate(source, mandateId);
      }
      setMandate(m);

      if (m) {
        // 2. Fetch charges from indexer
        if (api.isConfigured()) {
          try {
            const cRes = await api.charges(mandateId);
            setCharges(cRes?.charges ?? null);
            setChargesUnavailable(!cRes);
          } catch {
            setCharges(null);
            setChargesUnavailable(true);
          }
        } else {
          setCharges(null);
          setChargesUnavailable(true);
        }

        // 3. Fetch plan details and subscriber vault balance
        const [planRes, balRes] = await Promise.allSettled([
          payflow.getPlan(source, m.plan_id),
          payflow.vaultBalance(source, m.subscriber, m.token || config.contracts.token),
        ]);

        if (planRes.status === "fulfilled" && planRes.value) {
          const rawPlan = planRes.value as Plan;
          setPlan({
            id: Number(rawPlan.id),
            merchant: rawPlan.merchant,
            name: rawPlan.name,
            token: rawPlan.token,
            amount: rawPlan.amount.toString(),
            period: Number(rawPlan.period),
            active: rawPlan.active ? 1 : 0,
            ledger: 0,
          });
        }

        if (balRes.status === "fulfilled") {
          setVaultBalance(balRes.value);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [mandateId, address]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runAction(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setError(null);
    setDone(null);
    try {
      const tx = await fn();
      setDone(tx);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setConfirmCancel(false);
      setConfirmEnd(false);
    }
  }

  if (!mandateId) {
    return (
      <Empty
        title={tr("No mandate specified")}
        action={
          <Link href="/account" className="btn-primary">{tr("Go to my account")}</Link>
        }
      >{tr("Please provide a mandate ID in the URL, for example:")}{" "}<code>/mandates/?id=1</code>
      </Empty>
    );
  }

  if (loading) {
    return <SkeletonRows rows={5} label={tr("Loading mandate #{0}", { "0": mandateId })} />;
  }

  if (!mandate) {
    return (
      <Empty
        title={tr("Mandate #{0} not found", { "0": mandateId })}
        action={
          <Link href="/account" className="btn-primary">{tr("Go to my account")}</Link>
        }
      >{tr("This mandate does not exist or could not be loaded from contract state.")}</Empty>
    );
  }

  const status = mandateStatus(mandate.status);
  const isSubscriber = Boolean(address && mandate.subscriber.toLowerCase() === address.toLowerCase());
  const isMerchant = Boolean(address && mandate.merchant.toLowerCase() === address.toLowerCase());
  const isActive = status === "Active";
  const isPaused = status === "Paused";
  const isTerminal = status === "Cancelled" || status === "Expired";
  const isDue = isActive && now >= mandate.next_charge;

  // Fee calculation
  const rawAmount = BigInt(mandate.amount);
  const feeBps = BigInt(mandate.fee_bps);
  const feeAmount = (rawAmount * feeBps) / 10_000n;
  const netAmount = rawAmount - feeAmount;

  // Discount calculation
  const discBps = discountBps(mandate);
  const remDisc = remainingDiscountCharges(mandate);
  const hasDiscount = discBps > 0 && remDisc !== null && remDisc > 0;
  const currentAmount = hasDiscount ? discountedAmount(rawAmount, discBps) : rawAmount;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{tr("Mandate #")}{mandate.id}
            </h1>
            <Badge status={status} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {plan?.name ? (
              <>{tr("Subscription to")}{" "}
                <Link href={`/plans/${mandate.plan_id}`} className="text-accent hover:underline">
                  {plan.name}
                </Link>
              </>
            ) : (tr("Plan #{0}", { "0": mandate.plan_id })
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link href="/account" className="btn-ghost text-sm">{tr("My account")}</Link>
          <Link href="/merchant" className="btn-ghost text-sm">{tr("Merchant dashboard")}</Link>
        </div>
      </div>

      {error && <Notice tone="error">{translateMessage(error)}</Notice>}
      {done && (
        <Notice tone="ok">{tr("Done. Transaction")}{" "}<TxLink hash={done} />
        </Notice>
      )}

      {/* Primary stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={tr("Recurring amount")}
          value={`${fromStroops(currentAmount, 4, tokenMeta.decimals)} ${tokenMeta.symbol}`}
          hint={hasDiscount ?tr("Discount active ({0}% off)", { "0": discBps / 100 }) : formatPeriod(mandate.period)}
        />
        <Stat
          label={tr("Charges made")}
          value={`${mandate.charges_made} / ${mandate.max_charges > 0 ? mandate.max_charges : "∞"}`}
          hint={mandate.max_charges > 0 ?tr("{0} left", { "0": mandate.max_charges - mandate.charges_made }) :tr("open-ended")}
        />
        <Stat
          label={tr("Next charge")}
          value={!isTerminal && mandate.next_charge > 0 ? formatDate(mandate.next_charge) : tr("None")}
          hint={isDue ?tr("Due now") : !isTerminal ?tr("Scheduled") :tr("Terminal")}
        />
        <Stat
          label={tr("Protocol fee")}
          value={`${mandate.fee_bps / 100}%`}
          hint={`${formatTokenValue(feeAmount, 4, tokenMeta.decimals)} ${tokenMeta.symbol}`}
        />
      </div>

      {/* Mandate overview terms */}
      <Panel title={tr("Mandate details")} subtitle={tr("Authorized agreement parameters recorded on-chain")}>
        <div className="divide-y divide-edge text-sm">
          <div className="flex flex-wrap items-center justify-between py-2.5">
            <span className="text-muted">{tr("Subscriber")}</span>
            <div className="flex items-center gap-2">
              <AddressLink value={mandate.subscriber} />
              {isSubscriber && (
                <span className="rounded bg-accent/15 px-1.5 py-0.5 text-xs text-accent">{tr("You")}</span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between py-2.5">
            <span className="text-muted">{tr("Merchant")}</span>
            <div className="flex items-center gap-2">
              <AddressLink value={mandate.merchant} />
              {isMerchant && (
                <span className="rounded bg-accent/15 px-1.5 py-0.5 text-xs text-accent">{tr("You")}</span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between py-2.5">
            <span className="text-muted">{tr("Billing period")}</span>
            <span>{formatPeriod(mandate.period)}</span>
          </div>
          <div className="flex flex-wrap items-center justify-between py-2.5">
            <span className="text-muted">{tr("Net to merchant per charge")}</span>
            <span>{formatTokenValue(netAmount, 4, tokenMeta.decimals)} {tokenMeta.symbol}</span>
          </div>
          {vaultBalance !== null && (
            <div className="flex flex-wrap items-center justify-between py-2.5">
              <span className="text-muted">{tr("Subscriber vault balance")}</span>
              <span>{formatAmount(vaultBalance, tokenMeta)}</span>
            </div>
          )}
          {mandate.last_charge > 0 && (
            <div className="flex flex-wrap items-center justify-between py-2.5">
              <span className="text-muted">{tr("Last charge settled")}</span>
              <span>{formatDate(mandate.last_charge)}</span>
            </div>
          )}
        </div>

        {/* Action buttons (only what the connected wallet can take) */}
        {!isTerminal && address && (
          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-edge pt-4">
            {/* Charge action (Merchant or anyone when due) */}
            {(isMerchant || isDue) && isActive && (
              <button
                type="button"
                className="btn-primary"
                disabled={busy !== null || networkMismatch || !isDue}
                onClick={() =>
                  void runAction("charge", () => payflow.charge(address, signXdr, mandate.id))
                }
              >
                {busy === "charge" ?tr("Charging…") : isDue ?tr("Charge now") :tr("Not due yet")}
              </button>
            )}

            {/* Subscriber actions */}
            {isSubscriber && (
              <>
                {isActive && (
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy !== null || networkMismatch}
                    onClick={() =>
                      void runAction("pause", () =>
                        payflow.setPaused(address, signXdr, mandate.id, true),
                      )
                    }
                  >
                    {busy === "pause" ?tr("Pausing…") :tr("Pause subscription")}
                  </button>
                )}

                {isPaused && (
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy !== null || networkMismatch}
                    onClick={() =>
                      void runAction("resume", () =>
                        payflow.setPaused(address, signXdr, mandate.id, false),
                      )
                    }
                  >
                    {busy === "resume" ?tr("Resuming…") :tr("Resume subscription")}
                  </button>
                )}

                {!confirmCancel ? (
                  <button
                    type="button"
                    className="btn-danger"
                    disabled={busy !== null || networkMismatch}
                    onClick={() => setConfirmCancel(true)}
                  >{tr("Cancel subscription")}</button>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-danger">{tr("Confirm cancellation?")}</span>
                    <button
                      type="button"
                      className="btn-danger text-xs py-1"
                      disabled={busy !== null || networkMismatch}
                      onClick={() =>
                        void runAction("cancel", () => payflow.cancel(address, signXdr, mandate.id))
                      }
                    >
                      {busy === "cancel" ?tr("Cancelling…") :tr("Yes, cancel")}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost text-xs py-1"
                      onClick={() => setConfirmCancel(false)}
                    >{tr("No")}</button>
                  </div>
                )}
              </>
            )}

            {/* Merchant actions */}
            {isMerchant && !isSubscriber && (
              <>
                {isActive && (
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy !== null || networkMismatch}
                    onClick={() =>
                      void runAction("pause", () =>
                        payflow.setPaused(address, signXdr, mandate.id, true),
                      )
                    }
                  >
                    {busy === "pause" ?tr("Pausing…") :tr("Pause mandate")}
                  </button>
                )}

                {isPaused && (
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy !== null || networkMismatch}
                    onClick={() =>
                      void runAction("resume", () =>
                        payflow.setPaused(address, signXdr, mandate.id, false),
                      )
                    }
                  >
                    {busy === "resume" ?tr("Resuming…") :tr("Resume mandate")}
                  </button>
                )}

                {!confirmEnd ? (
                  <button
                    type="button"
                    className="btn-danger"
                    disabled={busy !== null || networkMismatch}
                    onClick={() => setConfirmEnd(true)}
                  >{tr("End mandate")}</button>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-danger">{tr("End this mandate permanently?")}</span>
                    <button
                      type="button"
                      className="btn-danger text-xs py-1"
                      disabled={busy !== null || networkMismatch}
                      onClick={() =>
                        void runAction("end", () =>
                          payflow.endMandate(address, signXdr, mandate.id),
                        )
                      }
                    >
                      {busy === "end" ?tr("Ending…") :tr("Yes, end")}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost text-xs py-1"
                      onClick={() => setConfirmEnd(false)}
                    >{tr("No")}</button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Panel>

      {/* Charge history */}
      <Panel
        title={tr("Charge history")}
        subtitle={tr("Individual charges settled under this mandate")}
      >
        {chargesUnavailable ? (
          <Notice tone="info">{tr("Charge history requires the indexer. When running in contract-only mode, individual transaction records are not available; the on-chain counters (charges made:")}{" "}{formatNumber(mandate.charges_made)}{tr(") are shown above.")}</Notice>
        ) : charges === null ? (
          <SkeletonRows rows={2} label={tr("Loading charge history")} />
        ) : charges.length === 0 ? (
          <Empty title={tr("No charges yet")}>{tr("No charges have been settled for this mandate so far.")}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-edge text-xs uppercase text-muted">
                <tr>
                  <th className="py-2 pr-4">{tr("Ledger")}</th>
                  <th className="py-2 px-4">{tr("Charge #")}</th>
                  <th className="py-2 px-4">{tr("Amount")}</th>
                  <th className="py-2 px-4">{tr("Fee")}</th>
                  <th className="py-2 pl-4">{tr("Transaction")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {charges.map((c) => (
                  <tr key={c.tx_hash} className="hover:bg-surface/50">
                    <td className="py-3 pr-4 tabular-nums">
                      #{c.ledger}
                    </td>
                    <td className="py-3 px-4 tabular-nums">
                      #{formatNumber(c.charges_made)}
                    </td>
                    <td className="py-3 px-4 font-medium tabular-nums">
                      {formatTokenValue(c.amount, 4, tokenMeta.decimals)} {tokenMeta.symbol}
                    </td>
                    <td className="py-3 px-4 text-muted tabular-nums">
                      {formatTokenValue(c.fee, 4, tokenMeta.decimals)} {tokenMeta.symbol}
                    </td>
                    <td className="py-3 pl-4">
                      <TxLink hash={c.tx_hash} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

export default function MandateDetailsPage() {
  const { t: tr } = useI18n();
  return (
    <Suspense fallback={<SkeletonRows rows={4} label={tr("Loading mandate")} />}>
      <MandateDetailsInner />
    </Suspense>
  );
}
