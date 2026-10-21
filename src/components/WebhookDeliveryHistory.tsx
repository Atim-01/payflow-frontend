"use client";

import { useI18n } from "@/i18n/provider";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { config } from "@/lib/config";
import { signWebhookProof } from "@/lib/sign-webhook-proof";
import { deliveryHistoryMessage, deliveryOutcome, type WebhookDelivery } from "@/lib/webhook-deliveries";
import { useWallet } from "@/lib/wallet";

export function WebhookDeliveryHistory({ merchant, webhookId }: { merchant: string; webhookId: string }) {
  const { t: tr } = useI18n();
  const { address, networkMismatch } = useWallet();
  if (!api.isConfigured()) return null;
  if (!address || address !== merchant) return <p className="mt-3 text-sm text-muted">{tr("Connect the merchant wallet to view delivery history.")}</p>;
  if (networkMismatch) return <p className="mt-3 text-sm text-muted">{tr("Switch your wallet to the correct network to view delivery history.")}</p>;
  return <History key={`${merchant}:${webhookId}`} merchant={merchant} webhookId={webhookId} />;
}

function History({ merchant, webhookId }: { merchant: string; webhookId: string }) {
  const { t: tr, translateMessage, formatExactTime, formatNumber } = useI18n();
  const [rows, setRows] = useState<WebhookDelivery[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); };
  }, []);

  async function refresh() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    setRows(null);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = await signWebhookProof(deliveryHistoryMessage(merchant, webhookId, timestamp, config.networkPassphrase), merchant);
      if (!mounted.current || controller.signal.aborted) return;
      timeout = setTimeout(() => controller.abort(), 15000);
      const result = await api.webhookDeliveries(webhookId, { merchant, timestamp, signature }, controller.signal);
      if (!mounted.current) return;
      if (result === null) setError(tr("Delivery history is unavailable. The backend may not support it yet, the proof may have expired, or the request failed. Try refreshing."));
      else setRows(result);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : "Could not sign the history request.");
    } finally {
      if (timeout) clearTimeout(timeout);
      request.current = null;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section className="mt-4 min-w-0 border-t border-edge pt-3" aria-label={tr("Delivery history for webhook {0}", { "0": webhookId })} aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{tr("Delivery history")}</h3>
        <button type="button" className="btn-ghost text-sm" disabled={busy} onClick={() => void refresh()} aria-label={tr("Refresh delivery history for webhook {0}", { "0": webhookId })}>
          {busy ?tr("Loading…") :tr("Refresh history")}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted">{tr("Sign a read-only message in your wallet to load the latest 100 delivery attempts.")}</p>
      <div aria-live="polite">
        {error && <p role="alert" className="mt-2 text-sm text-danger">{translateMessage(error)}</p>}
        {rows?.length === 0 && <p className="mt-2 text-sm text-muted">{tr("No deliveries yet.")}</p>}
      </div>
      {rows && rows.length > 0 && (
        <ol className="mt-3 space-y-2">
          {rows.map((row, index) => {
            const outcome = deliveryOutcome(row);
            return (
              <li key={`${row.id}:${row.attempt}:${index}`} className="rounded border border-edge p-3 text-sm">
                <p className="break-all font-medium">{row.event_id}</p>
                <p className={outcome.startsWith("Failed") ? "text-danger" : "text-soft"}>{translateMessage(outcome)}</p>
                <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div><dt className="text-xs text-muted">{tr("Status code")}</dt><dd>{row.http_status ??tr("No response")}</dd></div>
                  <div><dt className="text-xs text-muted">{tr("Attempt")}</dt><dd>{formatNumber(row.attempt)}</dd></div>
                  <div><dt className="text-xs text-muted">{tr("Next retry (UTC)")}</dt><dd className="break-words">{row.status === "pending" && row.retry_at ? formatExactTime(row.retry_at) :tr("None scheduled")}</dd></div>
                </dl>
                {row.error && <p className="mt-2 break-words text-danger">{row.error}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
