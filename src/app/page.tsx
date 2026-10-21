"use client";

import { useI18n } from "@/i18n/provider";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type ProtocolStats, type RecentCharge } from "@/lib/api";
import { chainProtocolStats } from "@/lib/chain";
import { config } from "@/lib/config";
import { AddressLink, Panel, Stat, TxLink } from "@/components/ui";
import{ shortAddress } from "@/lib/format";
import { metaFor, useTokenMetas } from "@/lib/token";

const STEPS = [
  {
    title: "The merchant publishes a plan",
    body: "Price, billing period, and token are written to the plan registry. The plan is public and immutable except for an on/off switch.",
  },
  {
    title: "The subscriber funds a vault and opens a mandate",
    body: "One signature. The plan's terms are copied into the mandate, so the merchant can never reprice it afterwards.",
  },
  {
    title: "Anyone settles the charge when it comes due",
    body: "The mandate is the authorization, so charging is permissionless. If our keeper stops, the merchant or the subscriber can still settle.",
  },
  {
    title: "The subscriber can leave at any time",
    body: "Cancel is unilateral and immediate. Withdrawing from the vault starves the mandate. Funds are never locked.",
  },
];

export default function HomePage() {
  const { t: tr, formatAmount, formatDate } = useI18n();
  const [stats, setStats] = useState<ProtocolStats | null>(null);
  const [contractPlanCount, setContractPlanCount] = useState<number | null>(null);
  const [recentCharges, setRecentCharges] = useState<RecentCharge[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const metas = useTokenMetas([config.contracts.token]);
  const tokenMeta = metaFor(metas, config.contracts.token);

  useEffect(() => {
    const load = async () => {
      const [s, r] = await Promise.allSettled([api.stats(), api.recentCharges(10)]);
      const statsValue = s.status === "fulfilled" ? s.value : null;
      if (statsValue) {
        setStats(statsValue);
      } else {
        // Only read contract counters when the indexer API is unreachable (no extra RPC when API works!)
        try {
          const chainStats = await chainProtocolStats(config.readSource);
          setContractPlanCount(chainStats.plans);
        } catch {
          // Keep blank if contract read fails
        }
      }
      if (r.status === "fulfilled" && r.value) setRecentCharges(r.value.charges);
      setLoaded(true);
    };
    void load();
  }, []);

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{tr("Recurring payments that Stellar could not do before.")}</h1>
        <p className="max-w-2xl text-muted">{tr("Stellar payments are push-only: the account holding the funds must sign every transfer. That makes one-off payments simple and subscriptions impossible without custody. Payflow adds the missing primitive — a bounded, revocable")}{" "}
          <strong className="text-soft">{tr("mandate")}</strong>{" "}{tr("the subscriber signs once.")}</p>
        <div className="flex flex-wrap gap-3 pt-1">
          <Link href="/subscribe" className="btn-primary">{tr("Browse plans")}</Link>
          <Link href="/merchant" className="btn-ghost">{tr("I'm a merchant")}</Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={tr("Plans")}
          value={loaded ? (stats?.plans ?? contractPlanCount ?? "—") : "…"}
          hint={!stats && contractPlanCount !== null ?tr("from contract") : undefined}
        />
        <Stat
          label={tr("Mandates")}
          value={loaded ? (stats?.mandates ?? "—") : "…"}
          hint={!stats ?tr("needs indexer") : undefined}
        />
        <Stat
          label={tr("Active")}
          value={loaded ? (stats?.activeMandates ?? "—") : "…"}
          hint={stats ?tr("currently billable") :tr("needs indexer")}
        />
        <Stat
          label={tr("Charges settled")}
          value={loaded ? (stats?.charges ?? "—") : "…"}
          hint={stats ?tr("ledger {0}", { "0": String(stats.lastIndexedLedger) }) :tr("needs indexer")}
        />
      </section>

      {loaded && !stats && (
        <p className="text-sm text-muted">{tr("The indexer is unreachable, so historical activity counters require the indexer.")}{contractPlanCount !== null ?tr(" Plan count is loaded directly from contract state.") : ""}
        </p>
      )}

      {recentCharges !== null && recentCharges.length > 0 && (
        <Panel title={tr("Recent activity")} subtitle={tr("Latest charges settled across the protocol")}>
          <div className="space-y-2">
            {recentCharges.map((charge) => (
              <div
                key={charge.tx_hash}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-edge p-3"
              >
                <div className="flex items-center gap-3 text-sm">
                  <span className="font-medium">{charge.plan_name ||tr("Plan #{0}", { "0": charge.plan_id })}</span>
                  <span className="mono text-xs text-muted">{tr("tx")}</span>
                  <TxLink hash={charge.tx_hash} />
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
                  <span className="tabular-nums font-medium text-fg">
                    {formatAmount(charge.amount, tokenMeta)}
                  </span>
                  <time dateTime={new Date(charge.timestamp * 1000).toISOString()}>
                    {formatDate(charge.timestamp)}
                  </time>
                  <span className="mono truncate max-w-[10rem]">
                    {shortAddress(charge.tx_hash, 6)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel title={tr("How it works")}>
        <ol className="space-y-4">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-4">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-edge text-xs text-muted">
                {i + 1}
              </span>
              <div>
                <h3 className="text-sm font-medium">{tr(step.title)}</h3>
                <p className="mt-1 text-sm text-muted">{tr(step.body)}</p>
              </div>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel title={tr("Deployed contracts")} subtitle={tr("Stellar testnet")}>
        <dl className="space-y-3 text-sm">
          {[
            ["Plan registry", config.contracts.planRegistry],
            ["Vault", config.contracts.vault],
            ["Subscription", config.contracts.subscription],
          ].map(([label, id]) => (
            <div key={label} className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-muted">{typeof label === "string" ? tr(label) : label}</dt>
              <dd>{id ? <AddressLink value={id} kind="contract" /> : <span className="text-muted">{tr("not configured")}</span>}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </div>
  );
}
