import { config } from "./config";
import { parseWebhookDeliveries } from "./webhook-deliveries";

export interface ApiPlan {
  id: number;
  merchant: string;
  /** Merchant-set label. Empty for plans created before names shipped. */
  name: string;
  token: string;
  amount: string;
  period: number;
  active: number;
  ledger: number;
  /**
   * Free trial in seconds, 0 meaning none.
   *
   * Optional on purpose: payflow-contract#9 has not shipped, so neither the
   * deployed `Plan` nor the indexer's rows carry it yet. `undefined` means
   * "this source cannot say", which is not the same as 0 — see `supportsTrials`.
   */
  trial?: number;
  /** Proposed #26 Unix-seconds cutoff; 0 is forever, absent is unsupported. */
  available_until?: number;
  /** Proposed #25 cap; 0 is unlimited, absent is unsupported. */
  max_subscribers?: number;
  /** Open mandates (including paused), not lifetime subscriptions. */
  subscriber_count?: number;
}

export interface ApiMandate {
  id: number;
  subscriber: string;
  merchant: string;
  plan_id: number;
  amount: string;
  period: number;
  next_charge: number;
  last_charge: number;
  charges_made: number;
  max_charges: number;
  /** Fee rate frozen at subscribe time; an admin change cannot move it. */
  fee_bps: number;
  status: string;
  /**
   * Token the amount is denominated in. Only the contract fallback fills this
   * in; the indexer does not serve it, so callers must fall back to the
   * configured token when it is absent.
   */
  token?: string;
  /** Who cancelled the mandate: "subscriber", "merchant", or null. */
  ended_by?: string | null;
  /**
   * The plan's trial in seconds, frozen into the mandate at subscribe time and
   * projected by the indexer from the `Subscribed` event payflow-contract#9
   * adds. Optional for the same reason as `ApiPlan.trial`: absent means the
   * source cannot say, which is not the same as zero.
   */
  trial?: number;
  /**
   * When a paused mandate resumes, as a Unix time, from payflow-contract#41.
   *
   * Optional because the field has not shipped: the contract only reports it
   * once the dated pause exists, and the indexer only serves what the contract
   * emits. Absent therefore means "this source cannot pause until a date",
   * which is what the account page uses to hide the control.
   */
  pause_until?: number;
  /**
   * When a past-due mandate's grace period ends, as a Unix time, from
   * payflow-contract#34.
   *
   * Optional because the field has not shipped: the contract only reports it
   * once the mandate is past due. Absent means the source cannot say.
   */
  past_due_until?: number;
  /**
   * The discount the merchant set on this mandate, in basis points, and how
   * many charges it covers.
   *
   * Optional for the same reason: payflow-contract#37 has not shipped, so
   * neither the deployed contract's `Mandate` nor the indexer's rows carry
   * them. Absent means the source cannot say — see `supportsDiscounts`.
   */
  discount_bps?: number;
  discount_charges?: number;
  /** How many of the discounted charges have been settled. */
  discount_charges_made?: number;
  /**
   * The maximum amount that can be refunded on this mandate, in the token's
   * smallest unit as a decimal string. From payflow-contract#36.
   *
   * Optional because the field has not shipped: the contract only reports it
   * once the refund feature is deployed. Absent means the source cannot say.
   */
  refundable_amount?: string;
}

export interface ApiCharge {
  tx_hash: string;
  mandate_id: number;
  amount: string;
  fee: string;
  charges_made: number;
  ledger: number;
}

/**
 * A charge attempt that failed, proposed by payflow-backend#144.
 *
 * The backend records every attempt to settle a charge, including failures.
 * This lets merchants understand why charges are failing and diagnose
 * subscriber issues (insufficient balance, paused mandate, etc.).
 */
export interface ApiChargeAttempt {
  /** Unique identifier for this attempt. */
  id: number;
  /** The mandate the charge was attempted against. */
  mandate_id: number;
  /** Unix timestamp when the charge was attempted. */
  attempted_at: number;
  /** Result: "success" or "failed". */
  result: "success" | "failed";
  /** Contract error code if the attempt failed, null otherwise. */
  error_code: number | null;
  /** Plain-language error message if the attempt failed, null otherwise. */
  error_message: string | null;
  /** Transaction hash if the charge succeeded, null otherwise. */
  tx_hash: string | null;
}

export interface ApiWebhook {
  id: string;
  url: string;
  events: string[];
  created_at: number;
  /**
   * The signing secret the backend sends with every webhook request so the
   * merchant can verify the payload came from payflow. Only included in the
   * creation response and shown to the merchant once — the backend cannot
   * re-send it.
   */
  secret?: string;
}

/**
 * What a form should say about a webhook URL the merchant typed.
 *
 * Webhooks deliver over the public internet, so only https endpoints are
 * accepted — an http URL would send payloads (and secrets) in the clear.
 */
export type WebhookUrlCheck =
  | { ok: true; url: string }
  | { ok: false; message: string };

export function checkWebhookUrl(input: string): WebhookUrlCheck {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, message: "Enter a webhook URL." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, message: "Enter a valid URL." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, message: "The URL must use https." };
  }
  return { ok: true, url: url.toString() };
}

export type VaultEventType = "deposit" | "withdraw" | "debit";

export interface ApiVaultEvent {
  type: VaultEventType;
  /** Amount in smallest units (stroops), as a decimal string. Always a positive magnitude; the sign is derived from `type`. */
  amount: string;
  tx_hash: string;
  ledger: number;
}

/**
 * Per-plan performance stats, proposed by payflow-backend#29.
 *
 * Optional fields are absent when the backend does not yet serve this endpoint
 * or when the data is unavailable. Callers must treat `undefined` as "cannot
 * say" rather than zero.
 *
 * `total_collected` is in smallest units (stroops) as a decimal string so
 * bigint math is always used — never floats.
 */
export interface ApiPlanStats {
  /** Open mandates (active + paused). */
  subscriber_count: number;
  /** Net of the protocol fee, in smallest units as a decimal string. */
  total_collected: string;
  /** Mandates ended by either party. */
  cancellations: number;
}

export interface MerchantSummary {
  merchant: string;
  activeMandates: number;
  /** null when served from chain fallback: charge history lives only in the indexer. */
  totalCollected: string | null;
  chargeCount: number;
  mrr: string;
}

export interface ProtocolStats {
  plans: number;
  mandates: number;
  activeMandates: number;
  charges: number;
  lastIndexedLedger: number;
}

export interface RecentCharge {
  tx_hash: string;
  plan_name: string;
  amount: string;
  ledger: number;
  timestamp: number;
  plan_id: number;
}

/**
 * Events emitted by the backend SSE stream (payflow-backend#19).
 *
 * The stream is scoped to a single wallet address (subscriber or merchant).
 * Each event carries the mandate id it pertains to so the UI can update
 * the affected row in place without a full reload.
 */
export type StreamEventType =
  | "charge"
  | "mandate_status"
  | "mandate_pause"
  | "mandate_discount"
  | "mandate_end";

export interface StreamEventBase {
  type: StreamEventType;
  mandate_id: number;
  /** Unix seconds when the event was indexed. */
  timestamp: number;
}

export interface StreamChargeEvent extends StreamEventBase {
  type: "charge";
  /** The charge that was settled. */
  charge: ApiCharge;
}

export interface StreamMandateStatusEvent extends StreamEventBase {
  type: "mandate_status";
  /** The new status: "Active", "Paused", "Cancelled", "Completed". */
  status: string;
  /** Who initiated the status change: "subscriber" or "merchant". */
  by: "subscriber" | "merchant";
}

export interface StreamMandatePauseEvent extends StreamEventBase {
  type: "mandate_pause";
  /** Unix seconds when the pause ends, or null for an indefinite pause. */
  pause_until: number | null;
  /** Who initiated the pause: "subscriber" or "merchant". */
  by: "subscriber" | "merchant";
}

export interface StreamMandateDiscountEvent extends StreamEventBase {
  type: "mandate_discount";
  /** New discount rate in basis points. */
  discount_bps: number;
  /** How many charges the discount covers. */
  discount_charges: number;
  /** How many discounted charges have been settled so far. */
  discount_charges_made: number;
}

export interface StreamMandateEndEvent extends StreamEventBase {
  type: "mandate_end";
  /** Who ended the mandate: "subscriber" or "merchant". */
  by: "subscriber" | "merchant";
}

export type StreamEvent =
  | StreamChargeEvent
  | StreamMandateStatusEvent
  | StreamMandatePauseEvent
  | StreamMandateDiscountEvent
  | StreamMandateEndEvent;

/**
 * The indexer is a convenience, not a source of truth. Every call here is
 * allowed to fail: the UI falls back to reading contract state directly so the
 * app still works when the backend is down.
 */
async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${config.apiUrl}${path}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function post<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${config.apiUrl}${path}`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function del(path: string): Promise<boolean> {
  try {
    const res = await fetch(`${config.apiUrl}${path}`, {
      method: "DELETE",
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const api = {
  /** Whether the backend URL was explicitly supplied for this build. */
  isConfigured: () => Boolean(process.env.NEXT_PUBLIC_API_URL?.trim()),
  stats: () => get<ProtocolStats>("/api/stats"),
  plans: (merchant?: string) =>
    get<{ plans: ApiPlan[] }>(`/api/plans${merchant ? `?merchant=${merchant}` : ""}`),
  mandatesOf: (subscriber: string) =>
    get<{ mandates: ApiMandate[] }>(`/api/mandates?subscriber=${subscriber}`),
  mandatesFor: (merchant: string) =>
    get<{ mandates: ApiMandate[] }>(`/api/mandates?merchant=${merchant}`),
  charges: (mandateId: number) =>
    get<{ charges: ApiCharge[] }>(`/api/mandates/${mandateId}/charges`),
  charge: async (mandateId: number, txHash: string): Promise<ApiCharge | null> => {
    const res = await get<{ charges: ApiCharge[] }>(`/api/mandates/${mandateId}/charges`);
    if (!res) return null;
    return res.charges.find((c) => c.tx_hash.toLowerCase() === txHash.toLowerCase()) ?? null;
  },
  mandate: async (id: number): Promise<ApiMandate | null> => {
    const res = await get<ApiMandate | { mandate: ApiMandate }>(`/api/mandates/${id}`);
    if (!res) return null;
    if ("mandate" in res) return res.mandate;
    return res;
  },
  vaultHistory: (address: string) =>
    get<{ events: ApiVaultEvent[] }>(`/api/vaults/${address}/history`),
  merchantSummary: (address: string) =>
    get<MerchantSummary>(`/api/merchants/${address}/summary`),
  /**
   * Revenue over time, proposed by payflow-backend#12 and not deployed yet.
   *
   * Shape kept loose on purpose (`unknown`, not a declared interface) so the
   * dashboard can tell "this backend does not serve the endpoint" from "this
   * merchant earned nothing"; `parseRevenue` in `lib/revenue` does the reading.
   */
  merchantRevenue: (
    address: string,
    params: { bucket?: string; from?: number; to?: number } = {},
  ) => {
    const query = new URLSearchParams();
    if (params.bucket) query.set("bucket", params.bucket);
    if (params.from !== undefined) query.set("from", String(params.from));
    if (params.to !== undefined) query.set("to", String(params.to));
    const qs = query.toString();
    return get<unknown>(`/api/merchants/${address}/revenue${qs ? `?${qs}` : ""}`);
  },
  /**
   * Monthly mandate lifecycle counts, proposed by payflow-backend#30.
   *
   * The endpoint is optional until deployed. An empty API URL must not turn
   * this into a same-origin request or a contract-only approximation.
   */
  merchantChurn: (address: string) => {
    if (!api.isConfigured()) return Promise.resolve(null);
    return get<unknown>(`/api/merchants/${address}/churn?bucket=month`);
  },
  due: () => get<{ now: number; due: ApiMandate[] }>("/api/due"),
  /**
   * Per-plan stats, proposed by payflow-backend#29.
   *
   * Returns null when the backend is unreachable or does not yet serve this
   * endpoint — the UI must hide the stats section rather than show stale zeros.
   */
  planStats: (planId: number) => get<ApiPlanStats>(`/api/plans/${planId}/stats`),
  webhooks: (merchant: string) =>
    get<{ webhooks: ApiWebhook[] }>(`/api/merchants/${merchant}/webhooks`).then(
      (body) => body?.webhooks ?? null,
    ),
  /** Proposed authenticated read for payflow-backend#140. Never cache proofs. */
  webhookDeliveries: async (
    id: string,
    proof: { merchant: string; timestamp: number; signature: string },
    signal?: AbortSignal,
  ) => {
    if (!api.isConfigured()) return null;
    try {
      const response = await fetch(`${config.apiUrl}/api/webhooks/${encodeURIComponent(id)}/deliveries`, {
        cache: "no-store",
        redirect: "error",
        signal,
        headers: {
          "X-Payflow-Merchant": proof.merchant,
          "X-Payflow-Timestamp": String(proof.timestamp),
          "X-Payflow-Signature": proof.signature,
        },
      });
      return response.ok ? parseWebhookDeliveries(await response.json()) : null;
    } catch {
      return null;
    }
  },
  /**
   * Proposed by payflow-backend#5. Returns the created webhook including the
   * signing secret, which the merchant must copy immediately — it is shown
   * once and never returned again.
   */
  addWebhook: (merchant: string, body: { url: string; events: string[] }) =>
    post<ApiWebhook>(`/api/merchants/${merchant}/webhooks`, body),
  deleteWebhook: (merchant: string, id: string) =>
    del(`/api/merchants/${merchant}/webhooks/${id}`),
  testWebhook: (merchant: string, id: string) =>
    post<{ ok: boolean }>(`/api/merchants/${merchant}/webhooks/${id}/test`, {}),
  /**
   * Rotate a webhook's signing secret, proposed by payflow-backend#139.
   *
   * Returns the new secret, which the merchant must copy immediately — it is
   * shown once and never returned again. The old secret remains valid for a
   * brief overlap period so the merchant can update their system without
   * missing events.
   */
  rotateWebhookSecret: (merchant: string, id: string) =>
    post<{ secret: string }>(`/api/merchants/${merchant}/webhooks/${id}/rotate-secret`, {}),
  /**
   * Recent charges across the protocol, proposed by payflow-backend#30.
   *
   * Returns null when the backend is unreachable or does not yet serve this
   * endpoint — the UI must hide the activity feed rather than show stale data.
   */
  recentCharges: (limit = 10) =>
    get<{ charges: RecentCharge[] }>(`/api/recent?limit=${limit}`),
  /**
   * Charge attempts for a mandate, proposed by payflow-backend#144.
   *
   * Returns null when the backend is unreachable or does not yet serve this
   * endpoint. Contract-only mode cannot reconstruct attempt history — only
   * successful charges are recorded on-chain.
   */
  chargeAttempts: (mandateId: number) =>
    get<{ attempts: ApiChargeAttempt[] }>(`/api/mandates/${mandateId}/attempts`).then(
      (body) => body?.attempts ?? null,
    ),

  /**
   * Unpaid subscribers for a merchant, proposed by payflow-backend#146.
   *
   * Returns active mandates where the subscriber's vault balance cannot cover
   * the next charge. Returns null when the backend is unreachable or does not
   * yet serve this endpoint — the UI falls back to checking vault balances
   * from contract state.
   */
  unpaidMandates: (merchant: string) =>
    get<{ unpaid: ApiMandate[] }>(`/api/merchants/${merchant}/unpaid`),

  /**
   * Cohort retention analysis by signup month, proposed by payflow-backend#142.
   *
   * Returns a grid showing what percentage of each month's signups remained
   * subscribed in subsequent months. The endpoint is optional until deployed.
   * An empty API URL must not turn this into a same-origin request or a
   * contract-only approximation.
   */
  merchantCohortRetention: (address: string) => {
    if (!api.isConfigured()) return Promise.resolve(null);
    return get<unknown>(`/api/merchants/${address}/cohort-retention?bucket=month`);
  },

  /**
   * Open an SSE stream for live updates scoped to the given address.
   *
   * The backend must be configured (NEXT_PUBLIC_API_URL set) and the deployed
   * backend must serve the `/api/stream` endpoint (payflow-backend#19).
   * Returns null when either condition is not met — the caller must not
   * attempt to open a stream in contract-only mode.
   *
   * The returned EventSource emits `message` events with JSON bodies matching
   * the `StreamEvent` union. The caller is responsible for closing the stream
   * when the component unmounts or the tab is hidden.
   */
  stream: (
    address: string,
    role: "subscriber" | "merchant",
  ): EventSource | null => {
    if (!api.isConfigured()) return null;
    const params = new URLSearchParams();
    params.set(role, address);
    const url = `${config.apiUrl}/api/stream?${params.toString()}`;
    try {
      return new EventSource(url);
    } catch {
      // EventSource not supported (e.g., non-browser test env)
      return null;
    }
  },
};
