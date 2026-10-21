import { StrKey } from "@stellar/stellar-sdk";
import { MAX_PAGE, mandateStatus, payflow, type Mandate, type Plan } from "./payflow";
import type { ApiCharge, ApiMandate, ApiPlan, ApiVaultEvent, MerchantSummary } from "./api";
import { availabilityInteger } from "./availability";
import { fromStroops } from "./format";
import { chargeShortfall } from "./schedule";

/**
 * Contract-only fallbacks for the lists the indexer normally serves.
 *
 * These exist so the app stays usable when `payflow-backend` is unreachable —
 * including the public demo deployment, which has no backend at all. They read
 * straight from contract state via simulation, so they are slower and cannot
 * aggregate, but they are always correct: the contract is the source of truth
 * and the indexer is only ever a cache of it.
 */

/** How many of the newest plans the contract-only fallback lists. */
const MAX_PLAN_PROBE = 24;

/** How many of the newest entries of an index the fallback reads. */
const MAX_INDEX_READ = 2 * MAX_PAGE;

function planToApi(plan: Plan): ApiPlan {
  return {
    id: Number(plan.id),
    merchant: plan.merchant,
    name: plan.name,
    token: plan.token,
    amount: plan.amount.toString(),
    period: Number(plan.period),
    active: plan.active ? 1 : 0,
    ledger: 0,
    // Left undefined, not 0, when the decoded Plan has no `trial` key: a
    // contract built before payflow-contract#9 cannot say whether the plan has
    // a trial, and 0 would claim it does not.
    ...(plan.trial !== undefined ? { trial: Number(plan.trial) } : {}),
    ...(plan.available_until !== undefined ? { available_until: availabilityInteger(plan.available_until) } : {}),
    ...(plan.max_subscribers !== undefined ? { max_subscribers: availabilityInteger(plan.max_subscribers) } : {}),
  };
}

async function planWithAvailability(source: string, plan: Plan): Promise<ApiPlan> {
  const result = planToApi(plan);
  if (result.max_subscribers) {
    try {
      result.subscriber_count = availabilityInteger(await payflow.planSubscriberCount(source, plan.id));
    } catch {
      // Old contracts and failed reads cannot report seats. Never assume zero.
    }
  }
  return result;
}

/** Exported for tests. */
export function mandateToApi(mandate: Mandate): ApiMandate {
  return {
    id: Number(mandate.id),
    subscriber: mandate.subscriber,
    merchant: mandate.merchant,
    plan_id: Number(mandate.plan_id),
    amount: mandate.amount.toString(),
    period: Number(mandate.period),
    next_charge: Number(mandate.next_charge),
    last_charge: Number(mandate.last_charge),
    charges_made: mandate.charges_made,
    max_charges: mandate.max_charges,
    fee_bps: mandate.fee_bps,
    status: mandateStatus(mandate.status),
    token: mandate.token,
    // Contract state does not record who cancelled; only the indexer knows.
    ended_by: null,
    // Only present once payflow-contract#9 mirrors `trial` onto the mandate;
    // see `ApiPlan.trial` for why this stays undefined rather than 0.
    ...(mandate.trial !== undefined ? { trial: Number(mandate.trial) } : {}),
    // Only present once payflow-contract#41 adds `pause_until` to Mandate; a
    // contract decoded without it cannot service a dated pause, and the page
    // hides the control instead of guessing at support.
    ...(mandate.pause_until !== undefined
      ? { pause_until: Number(mandate.pause_until) }
      : {}),
    // Only present once payflow-contract#37 mirrors the discount onto the
    // mandate; a contract without the fields cannot say, and a zero would
    // claim there is no discount where there is one.
    ...(mandate.discount_bps !== undefined
      ? { discount_bps: Number(mandate.discount_bps) }
      : {}),
    ...(mandate.discount_charges !== undefined
      ? { discount_charges: Number(mandate.discount_charges) }
      : {}),
    ...(mandate.discount_charges_made !== undefined
      ? { discount_charges_made: Number(mandate.discount_charges_made) }
      : {}),
    // Only present once payflow-contract#34 adds `past_due_until` to Mandate;
    // a contract without it cannot say when the grace period ends.
    ...(mandate.past_due_until !== undefined
      ? { past_due_until: Number(mandate.past_due_until) }
      : {}),
    // Only present once payflow-contract#36 adds `refundable_amount` to Mandate;
    // a contract without it cannot say how much can be refunded.
    ...(mandate.refundable_amount !== undefined
      ? { refundable_amount: mandate.refundable_amount.toString() }
      : {}),
  };
}

async function settledValues<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

/**
 * Page positions that cover the newest `want` of `count` index entries, as
 * [start, limit] pairs of at most `pageSize`. Exported for tests.
 */
export function newestPages(count: number, want: number, pageSize = MAX_PAGE): [number, number][] {
  const from = Math.max(0, count - want);
  const pages: [number, number][] = [];
  for (let start = from; start < count; start += pageSize) {
    pages.push([start, Math.min(pageSize, count - start)]);
  }
  return pages;
}

/** Read the newest ids from a paged contract index. */
async function newestIds(
  count: number,
  page: (start: number, limit: number) => Promise<bigint[]>,
): Promise<bigint[]> {
  const pages = await Promise.all(
    newestPages(count, MAX_INDEX_READ).map(([start, limit]) => page(start, limit)),
  );
  return pages.flat();
}

/**
 * The newest plans, read by id.
 *
 * The registry has no "list all" function (that is the gap the indexer fills),
 * but ids are sequential and `next_plan_id` says where they end, so this reads
 * the newest few. Bounded deliberately: an unbounded read would hammer RPC.
 *
 * Each record comes from `payflow.getPlan`, which caches it for the session, so
 * a second visit re-reads only `next_plan_id` — the one value that a newly
 * published plan changes.
 */
export async function chainPlans(source: string): Promise<ApiPlan[]> {
  const next = Number(await payflow.nextPlanId(source));
  const newest = Math.min(MAX_PLAN_PROBE, Math.max(0, next - 1));
  const ids = Array.from({ length: newest }, (_, i) => next - 1 - i);
  const found = await settledValues(ids.map((id) => payflow.getPlan(source, id)));
  return (await Promise.all(found.map((p) => planWithAvailability(source, p)))).sort((a, b) => b.id - a.id);
}

export async function chainPlansOf(source: string, merchant: string): Promise<ApiPlan[]> {
  const count = await payflow.merchantPlanCount(source, merchant);
  const ids = await newestIds(count, (s, l) => payflow.merchantPlans(source, merchant, s, l));
  const plans = await settledValues(ids.map((id) => payflow.getPlan(source, id)));
  return plans.map(planToApi).sort((a, b) => b.id - a.id);
}

/**
 * Read the open-mandate count for a single plan from contract state.
 *
 * Returns null when the deployed contract predates `plan_subscriber_count`
 * (payflow-contract#25), so the caller can hide the stat rather than show
 * a misleading zero.
 *
 * Exported for tests.
 */
export async function chainPlanSubscriberCount(
  source: string,
  planId: number,
): Promise<number | null> {
  try {
    return await payflow.planSubscriberCount(source, planId);
  } catch {
    // Old contracts do not expose this getter. Return null so the UI can
    // hide the subscriber count rather than claim it is zero.
    return null;
  }
}

export async function chainMandatesOf(
  source: string,
  subscriber: string,
): Promise<ApiMandate[]> {
  const count = await payflow.subscriberMandateCount(source, subscriber);
  const ids = await newestIds(count, (s, l) =>
    payflow.subscriberMandates(source, subscriber, s, l),
  );
  const mandates = await settledValues(ids.map((id) => payflow.getMandate(source, id)));
  return mandates.map(mandateToApi).sort((a, b) => b.id - a.id);
}

export async function chainMandatesFor(
  source: string,
  merchant: string,
): Promise<ApiMandate[]> {
  const count = await payflow.merchantMandateCount(source, merchant);
  const ids = await newestIds(count, (s, l) => payflow.merchantMandates(source, merchant, s, l));
  const mandates = await settledValues(ids.map((id) => payflow.getMandate(source, id)));
  return mandates.map(mandateToApi).sort((a, b) => b.id - a.id);
}

/**
 * Read a single mandate from contract state.
 */
export async function chainMandate(
  source: string,
  mandateId: number,
): Promise<ApiMandate | null> {
  try {
    const raw = await payflow.getMandate(source, mandateId);
    if (!raw) return null;
    return mandateToApi(raw);
  } catch {
    return null;
  }
}

/**
 * Reads protocol counters directly from contract state when the indexer is offline.
 * Only returns what contract state can determine (plans count from next_plan_id).
 */
export async function chainProtocolStats(source: string): Promise<{ plans: number }> {
  const next = Number(await payflow.nextPlanId(source));
  return { plans: Math.max(0, next - 1) };
}

/** A merchant can end a mandate that could still be charged. */
export function endable(m: Pick<ApiMandate, "status">): boolean {
  return m.status === "Active" || m.status === "Paused";
}

/**
 * The merchant address a shareable `/m/?address=G…` link points at, or null
 * when the parameter is missing or is not a valid Stellar account. Exported
 * for tests: a typo'd link must land on the "check your link" state, not on
 * an RPC call that fails somewhere later.
 */
export function merchantFromParam(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  return StrKey.isValidEd25519PublicKey(value) ? value : null;
}

/** Merchant totals derived from mandates alone. Charge history needs the indexer. */
export function chainMerchantSummary(
  address: string,
  mandates: ApiMandate[],
): MerchantSummary {
  const active = mandates.filter((m) => m.status === "Active");
  const mrr = active.reduce(
    (sum, m) => sum + (BigInt(m.amount) * 2_592_000n) / BigInt(m.period || 1),
    0n,
  );
  return {
    merchant: address,
    activeMandates: active.length,
    // Charge history lives in the indexer; without it, report what is knowable.
    totalCollected: null,
    chargeCount: mandates.reduce((n, m) => n + m.charges_made, 0),
    mrr: mrr.toString(),
  };
}

/** A charge row for display: gross, fee, and net as decimal strings. */
export interface PlanCharge {
  mandateId: number;
  subscriber: string;
  amount: string;
  fee: string;
  net: string;
  txHash: string;
  ledger: number;
}

/** Build a display row for a charge settled against a plan. Amounts never use floats. */
export function planChargeRow(charge: ApiCharge, subscriber: string): PlanCharge {
  const amount = BigInt(charge.amount);
  const fee = BigInt(charge.fee);
  return {
    mandateId: charge.mandate_id,
    subscriber,
    amount: fromStroops(amount),
    fee: fromStroops(fee),
    net: fromStroops(amount - fee),
    txHash: charge.tx_hash,
    ledger: charge.ledger,
  };
}

/** Whether a mandate can be charged against a subscriber's vault balance.
 *
 * `shortfall` is in stroops (smallest unit) and is zero when funded.
 */
export interface MandateFunding {
  status: "funded" | "short";
  shortfall: bigint;
}

/** Compare a vault balance against a mandate amount. Returns "short" with the
 * stroops shortfall when the vault cannot cover one charge, "funded" otherwise.
 * A null balance (read still in flight or failed) is treated as unknown: not
 * short, so the UI can show "—" rather than wrongly blocking a charge. */
export function mandateFunding(
  vaultBalance: bigint | null,
  mandateAmount: bigint,
): MandateFunding {
  // A null balance (read still in flight or failed) is unknown: don't block
  // the charge on a missing read. Treat it as not-short.
  const shortfall = chargeShortfall(vaultBalance, mandateAmount);
  return shortfall === null
    ? { status: "funded", shortfall: 0n }
    : { status: "short", shortfall };
}

/** Whether a vault event increases the vault balance. */
export function vaultEventIsCredit(event: ApiVaultEvent): boolean {
  return event.type === "deposit";
}

/** Human-readable text label for a vault event type. Carries meaning without
 * relying on colour alone. */
export function vaultEventLabel(event: ApiVaultEvent): string {
  switch (event.type) {
    case "deposit":
      return "Deposit";
    case "withdraw":
      return "Withdrawal";
    case "debit":
      return "Debit";
    default:
      return String(event.type);
  }
}

/** Signed decimal-string amount for display: deposits are positive, withdrawals
 * and debits are negative. Amounts stay in smallest units until formatted, so
 * no floating point is ever used for money. */
export function vaultEventAmount(event: ApiVaultEvent): string {
  const sign = vaultEventIsCredit(event) ? "+" : "-";
  return `${sign}${fromStroops(event.amount)}`;
}

/** Tone class key for colour-coding: deposits are "ok" (green), withdrawals
 * and debits are "error" (rose). Colour is an enhancement; the text label and
 * sign carry the meaning. */
export function vaultEventTone(event: ApiVaultEvent): "ok" | "error" {
  return vaultEventIsCredit(event) ? "ok" : "error";
}

/** Return a new array of vault events sorted newest first by ledger. */
export function sortVaultEventsNewestFirst(events: ApiVaultEvent[]): ApiVaultEvent[] {
  return [...events].sort((a, b) => b.ledger - a.ledger);
}

/**
 * An unpaid mandate: due but the subscriber's vault cannot cover the charge.
 *
 * All amounts stay in smallest units (stroops); time is Unix seconds.
 */
export interface UnpaidMandate {
  mandate: ApiMandate;
  /** How much the vault falls short, in smallest units. */
  shortfall: bigint;
  /** How long the charge has been overdue, in seconds. */
  overdueDuration: number;
}

/**
 * Contract-only fallback for unpaid mandates.
 *
 * Reads active mandates for the merchant and checks each subscriber's vault
 * balance. Returns mandates where the vault cannot cover the next charge and
 * that charge is already due.
 *
 * Sorted by most overdue first: a merchant addresses the oldest shortfalls
 * before newer ones, so the list reflects urgency rather than mandate id.
 */
export async function chainUnpaidMandates(
  source: string,
  merchant: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<UnpaidMandate[]> {
  const mandates = await chainMandatesFor(source, merchant);
  const active = mandates.filter((m) => m.status === "Active" && m.next_charge <= now);

  const results = await Promise.allSettled(
    active.map(async (mandate): Promise<UnpaidMandate | null> => {
      try {
        const amount = BigInt(mandate.amount);
        const balance = await payflow.vaultBalance(source, mandate.subscriber, mandate.token ?? source);
        const shortfall = chargeShortfall(balance, amount);
        if (shortfall === null || shortfall === 0n) return null;
        return {
          mandate,
          shortfall,
          overdueDuration: now - mandate.next_charge,
        };
      } catch {
        return null;
      }
    }),
  );

  const unpaid = results
    .flatMap((r) => (r.status === "fulfilled" && r.value !== null ? [r.value] : []))
    .sort((a, b) => b.overdueDuration - a.overdueDuration);

  return unpaid;
}


