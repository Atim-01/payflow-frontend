"use client";

import { useI18n } from "@/i18n/provider";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, type ApiPlan } from "@/lib/api";
import { chainPlansOf, merchantFromParam } from "@/lib/chain";
import { config } from "@/lib/config";
import { payflow } from "@/lib/payflow";
import { useWallet } from "@/lib/wallet";
import{ fromStroops } from "@/lib/format";
import { metaFor, useTokenMetas } from "@/lib/token";
import {
  AddressLink,
  Empty,
  MerchantAccount,
  Notice,
  Panel,
  SkeletonPlanCards,
  TxLink,
} from "@/components/ui";

/**
 * The public catalogue a merchant can link to: `/m/?address=G…` lists that
 * merchant's active plans with Subscribe buttons.
 *
 * The query parameter (not a path segment) is what makes this work in the
 * static export — every route is one prebuilt file, so per-merchant state has
 * to arrive at runtime. The page is a shell plus a `<Suspense>` boundary
 * because `useSearchParams` must be behind one for the prerenderer.
 *
 * Data comes from the indexer when it is configured and reachable, and falls
 * straight back to contract state (`chainPlansOf`) when it is not, so the
 * page works on the backend-less public demo. Subscribing needs a wallet,
 * like every write in this app.
 */

function MerchantCatalogue() {
  const { t: tr, formatPeriod, translateMessage, formatTokenValue } = useI18n();
  const params = useSearchParams();
  const merchant = merchantFromParam(params.get("address"));
  const { address, networkMismatch, signXdr } = useWallet();
  const [plans, setPlans] = useState<ApiPlan[] | null>(null);
  const [direct, setDirect] = useState(false);
  const [maxCharges, setMaxCharges] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // The visitor's wallet is only the simulation source; the catalogue itself
  // belongs to the address in the link and must not change with the wallet.
  const source = address ?? config.readSource;

  // Each plan can name a different token, so the cards read their own.
  const metas = useTokenMetas((plans ?? []).map((p) => p.token));

  // Guards against a wallet switching accounts mid-load: only the newest
  // request may write state.
  const loadId = useRef(0);

  const load = useCallback(async () => {
    if (!merchant) return;
    const id = (loadId.current += 1);
    setPlans(null);
    setError(null);

    const res = await api.plans(merchant);
    if (loadId.current !== id) return;
    if (res) {
      setPlans(res.plans);
      setDirect(false);
      return;
    }
    // No indexer: read this merchant's plans straight from the registry.
    try {
      setPlans(await chainPlansOf(source, merchant));
    } catch {
      setPlans([]);
    }
    if (loadId.current === id) setDirect(true);
  }, [merchant, source]);

  useEffect(() => {
    void load();
  }, [load]);

  async function subscribe(plan: ApiPlan) {
    if (!address) {
      setError(tr("Connect a wallet first."));
      return;
    }
    if (networkMismatch) {
      setError(tr("Switch your wallet to the correct network first."));
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
      const hash = await payflow.subscribe(address, signXdr, plan.id, limit);
      setDone(hash);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (!merchant) {
    return (
      <Panel title={tr("Merchant page")}>
        <Notice tone="error">{tr("This link is missing a merchant address. Share links look like")}<code className="mx-1">/m/?address=G…</code>{" "}{tr("— copy yours from the merchant dashboard.")}</Notice>
      </Panel>
    );
  }

  const active = (plans ?? []).filter((p) => p.active === 1);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          <MerchantAccount value={merchant} />
        </h1>
        <p className="mt-1 text-sm text-muted">{tr("Plans published by this merchant. Subscribing opens a mandate; fund your vault on the")}{" "}
          <Link href="/account" className="text-accent hover:underline">{tr("account page")}</Link>{" "}{tr("or charges will fail for lack of balance.")}</p>
      </div>

      {direct && (
        <Notice tone="info">{tr("Reading plans directly from the contract — the indexer is not reachable, so this list may be capped at the merchant's newest plans.")}</Notice>
      )}
      {error && <Notice tone="error">{translateMessage(error)}</Notice>}
      {done && (
        <Notice tone="ok">{tr("Subscribed. Transaction")}{" "}<TxLink hash={done} />
        </Notice>
      )}

      {plans === null ? (
        <SkeletonPlanCards label={tr("Loading plans")} />
      ) : active.length === 0 ? (
        <Empty>{tr("This merchant has no active plans right now.")}</Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {active.map((plan) => {
            const meta = metaFor(metas, plan.token);
            return (
              <Panel key={plan.id} title={plan.name ||tr("Plan #{0}", { "0": plan.id })}>
                <div className="space-y-3">
                  <div>
                    <div className="text-2xl font-semibold tabular-nums">
                      {formatTokenValue(plan.amount, 4, meta.decimals)}{" "}
                      <span className="text-sm font-normal text-muted">
                        {meta.symbol}
                      </span>
                    </div>
                    <div className="text-sm text-muted">
                      {formatPeriod(plan.period)}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-muted">{tr("Merchant")}</span>
                    <AddressLink value={plan.merchant} />
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
                    disabled={busy === plan.id || !address || networkMismatch}
                    onClick={() => void subscribe(plan)}
                  >
                    {busy === plan.id
                      ?tr("Confirming…")
                      : networkMismatch
                        ?tr("Wrong network")
                        : address
                          ?tr("Subscribe")
                          :tr("Connect wallet to subscribe")}
                  </button>
                </div>
              </Panel>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function MerchantPublicPage() {
  const { t: tr } = useI18n();
  return (
    <Suspense fallback={<SkeletonPlanCards label={tr("Loading merchant")} />}>
      <MerchantCatalogue />
    </Suspense>
  );
}
