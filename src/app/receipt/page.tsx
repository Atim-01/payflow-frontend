"use client";

import { useI18n } from "@/i18n/provider";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AddressLink, Notice, Skeleton, TxLink } from "@/components/ui";
import { loadReceipt, parseReceiptParams, type ReceiptData } from "@/lib/receipt";

function ReceiptSkeleton() {
  const { t: tr } = useI18n();
  return (
    <div className="mx-auto max-w-2xl space-y-6 py-6" role="status" aria-busy="true">
      <span className="sr-only">{tr("Loading receipt…")}</span>
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-8 w-24 rounded-lg" />
      </div>
      <div className="rounded-xl border border-edge bg-panel p-6 space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-6 w-36" />
          <Skeleton className="h-4 w-56" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    </div>
  );
}

function ReceiptContent() {
  const { t: tr, formatAmount, formatPeriod } = useI18n();
  const searchParams = useSearchParams();
  const txParam = searchParams.get("tx");
  const mandateParam = searchParams.get("mandate");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [apiAvailable, setApiAvailable] = useState(true);

  useEffect(() => {
    const { txHash, mandateId, error: parseError } = parseReceiptParams({
      tx: txParam,
      mandate: mandateParam,
    });

    if (parseError || !txHash || mandateId === null) {
      setError(parseError || "Invalid receipt parameters.");
      setLoading(false);
      return;
    }

    let active = true;
    void loadReceipt(mandateId, txHash).then((res) => {
      if (!active) return;
      setReceipt(res.receipt);
      setApiAvailable(res.apiAvailable);
      setError(res.error);
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [txParam, mandateParam]);

  if (loading) {
    return <ReceiptSkeleton />;
  }

  if (error || !receipt) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 py-6">
        <div className="flex items-center justify-between print:hidden">
          <Link
            href="/"
            className="text-sm text-muted transition hover:text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >{tr("← Back to overview")}</Link>
        </div>

        <Notice tone="error">
          <div className="space-y-1">
            <p className="font-medium">{tr("Could not load receipt")}</p>
            <p className="text-sm opacity-90">{error ??tr("Receipt details not found.")}</p>
          </div>
        </Notice>

        <p className="text-xs text-muted">{tr("A receipt requires both a transaction hash and mandate ID in the URL, for example:")}{" "}
          <code className="rounded bg-white/10 px-1.5 py-0.5">
            /receipt/?tx=abc…&mandate=1
          </code>
        </p>
      </div>
    );
  }

  const grossFormatted = formatAmount(receipt.gross, receipt.tokenMeta);
  const feeFormatted = formatAmount(receipt.fee, receipt.tokenMeta);
  const netFormatted = formatAmount(receipt.net, receipt.tokenMeta);

  return (
    <div className="mx-auto max-w-2xl space-y-6 py-2 print:max-w-none print:space-y-3 print:py-0">
      {/* Action controls (screen only) */}
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          href="/"
          className="text-sm text-muted transition hover:text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >{tr("← Back to overview")}</Link>
        <button
          type="button"
          onClick={() => window.print()}
          className="btn-primary inline-flex items-center gap-2"
          aria-label={tr("Print this receipt")}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <polyline points="6 9 6 2 18 2 18 9" />
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
            <rect x="6" y="14" width="12" height="8" />
          </svg>
          <span>{tr("Print receipt")}</span>
        </button>
      </div>

      {/* Contract-only explanation banner when API data is unavailable */}
      {!apiAvailable && (
        <div className="print:hidden">
          <Notice tone="info">
            <span className="font-medium text-slate-200">{tr("Contract-only mode:")}</span>{" "}{tr("Detailed historical charge logs require the indexer API (")}<code className="text-xs">NEXT_PUBLIC_API_URL</code>{tr("). Because the API is unreachable, this receipt is constructed from on-chain mandate state. You can verify the transaction directly on the Stellar explorer below.")}</Notice>
        </div>
      )}

      {/* Printable Receipt Card */}
      <article
        className="rounded-xl border border-edge bg-panel p-6 shadow-sm sm:p-8 print:m-0 print:max-w-none print:border print:border-slate-300 print:bg-white print:p-6 print:text-black print:shadow-none"
        style={{ breakInside: "avoid", pageBreakInside: "avoid" }}
        aria-label={tr("Payment receipt for mandate {0}", { "0": receipt.mandateId })}
      >
        {/* Header */}
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-edge pb-5 print:border-slate-300 print:pb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold tracking-tight print:text-black">{tr("Pay")}<span className="text-accent print:text-emerald-700">{tr("flow")}</span>
              </span>
              <span className="text-xs uppercase tracking-wider text-muted print:text-slate-500">{tr("Receipt")}</span>
            </div>
            <h1 className="mt-1 text-xl font-semibold tracking-tight print:text-black">{tr("Payment Receipt")}</h1>
            <p className="mt-0.5 text-xs text-muted print:text-slate-600">{tr("Mandate #")}{receipt.mandateId}{" "}{tr("· Plan #")}{receipt.planId}
            </p>
          </div>

          <div className="flex flex-col items-end gap-1.5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-semibold text-accent print:border print:border-emerald-600 print:bg-emerald-50 print:text-emerald-800">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-3 w-3"
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>{tr("Settled")}</span>
            <span className="text-xs text-muted print:text-slate-600 tabular-nums">
              {receipt.date}
            </span>
          </div>
        </header>

        {/* Parties and Mandate info */}
        <section className="grid gap-4 py-5 sm:grid-cols-2 print:gap-3 print:py-3 text-xs">
          <div className="space-y-1">
            <span className="label print:text-slate-500 print:mb-0.5">{tr("Subscriber (Payer)")}</span>
            <div className="print:hidden">
              <AddressLink value={receipt.subscriber} kind="account" />
            </div>
            <div className="hidden font-mono text-[11px] break-all print:block print:text-black">
              {receipt.subscriber}
            </div>
          </div>

          <div className="space-y-1">
            <span className="label print:text-slate-500 print:mb-0.5">{tr("Merchant (Payee)")}</span>
            <div className="print:hidden">
              <AddressLink value={receipt.merchant} kind="account" />
            </div>
            <div className="hidden font-mono text-[11px] break-all print:block print:text-black">
              {receipt.merchant}
            </div>
          </div>

          <div className="space-y-0.5">
            <span className="label print:text-slate-500 print:mb-0.5">{tr("Billing frequency")}</span>
            <div className="font-medium text-slate-200 print:text-black">
              {formatPeriod(receipt.period)}
            </div>
          </div>

          <div className="space-y-0.5">
            <span className="label print:text-slate-500 print:mb-0.5">{tr("Charge sequence")}</span>
            <div className="font-medium text-slate-200 print:text-black">
              {receipt.chargeNumber !== null
                ? receipt.totalCharges
                  ?tr("Charge {0} of {1}", { "0": receipt.chargeNumber, "1": receipt.totalCharges })
                  :tr("Charge #{0}", { "0": receipt.chargeNumber })
                :tr("Recurring charge")}
              {receipt.ledger ?tr(" · Ledger #{0}", { "0": String(receipt.ledger) }) : ""}
            </div>
          </div>
        </section>

        {/* Amounts Breakdown Table */}
        <section className="border-t border-edge py-4 print:border-slate-300 print:py-3">
          <h2 className="sr-only">{tr("Payment breakdown")}</h2>
          <table className="w-full text-sm print:text-xs">
            <thead>
              <tr className="border-b border-edge text-left text-xs uppercase tracking-wider text-muted print:border-slate-300 print:text-slate-500">
                <th className="pb-2 font-medium">{tr("Description")}</th>
                <th className="pb-2 text-right font-medium">{tr("Amount")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge print:divide-slate-200">
              <tr>
                <td className="py-2.5 text-muted print:text-slate-700">{tr("Subscription charge (Mandate #")}{receipt.mandateId})
                </td>
                <td className="py-2.5 text-right font-mono text-slate-200 print:text-black tabular-nums">
                  {grossFormatted}
                </td>
              </tr>
              <tr>
                <td className="py-2 text-muted print:text-slate-700">{tr("Protocol fee")}</td>
                <td className="py-2 text-right font-mono text-muted print:text-slate-600 tabular-nums">
                  -{feeFormatted}
                </td>
              </tr>
              <tr>
                <td className="py-2 text-muted print:text-slate-700">{tr("Net payout to merchant")}</td>
                <td className="py-2 text-right font-mono text-muted print:text-slate-600 tabular-nums">
                  {netFormatted}
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-edge text-base font-semibold print:border-slate-400 print:text-sm">
                <th scope="row" className="pt-3 text-left print:text-black">{tr("Total Paid")}</th>
                <td className="pt-3 text-right font-mono text-accent print:text-black tabular-nums">
                  {grossFormatted}
                </td>
              </tr>
            </tfoot>
          </table>
        </section>

        {/* Transaction Reference & Verification */}
        <footer className="border-t border-edge pt-4 text-xs text-muted print:border-slate-300 print:pt-3 print:text-slate-600">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-slate-300 print:text-slate-700">{tr("Transaction proof:")}</span>
              <div className="print:hidden">
                <TxLink hash={receipt.txHash} />
              </div>
            </div>
            <div className="hidden font-mono text-[11px] break-all print:block print:text-black">{tr("Hash:")}{" "}{receipt.txHash}
            </div>
            <div className="hidden text-[10px] text-slate-500 break-all print:block">{tr("Verify: https://stellar.expert/explorer/testnet/tx/")}{receipt.txHash}
            </div>
            <p className="text-[11px] text-muted/80 print:text-slate-500">{tr("Settled permissionlessly on Stellar via Payflow recurring mandate. Funds debited directly from subscriber vault.")}</p>
          </div>
        </footer>
      </article>
    </div>
  );
}

export default function ReceiptPage() {
  return (
    <Suspense fallback={<ReceiptSkeleton />}>
      <ReceiptContent />
    </Suspense>
  );
}
