/** XLM and most SEP-41 tokens use 7 decimal places. */
export const DECIMALS = 7;

/** The scaling, symbol and decimals of the token an amount is denominated in. */
export interface TokenMeta {
  symbol: string;
  decimals: number;
}

/**
 * Native XLM. Also the fallback for any token whose contract metadata cannot
 * be read, so the UI still shows something sensible rather than a blank unit.
 */
export const XLM: TokenMeta = { symbol: "XLM", decimals: DECIMALS };

/**
 * SEP-41 `decimals` is a u32 a token can set to anything, including values that
 * would make `10n ** decimals` enormous. Clamp to the range `u32` money can
 * realistically use so one bad token cannot hang the page.
 */
const MIN_DECIMALS = 0;
const MAX_DECIMALS = 18;

function normalizeDecimals(decimals: number): number {
  if (!Number.isFinite(decimals)) return DECIMALS;
  return Math.min(MAX_DECIMALS, Math.max(MIN_DECIMALS, Math.trunc(decimals)));
}

/** Convert a smallest-unit string ("9900000") to a display string ("0.99"). */
export function fromStroops(
  raw: string | bigint,
  maxFractionDigits = 4,
  decimals = DECIMALS,
): string {
  let value: bigint;
  try {
    value = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  } catch {
    return "0";
  }
  const places = normalizeDecimals(decimals);
  const scale = 10n ** BigInt(places);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / scale;
  const frac = abs % scale;

  let fracStr = frac.toString().padStart(places, "0").slice(0, maxFractionDigits);
  fracStr = fracStr.replace(/0+$/, "");

  const body = fracStr ? `${whole}.${fracStr}` : whole.toString();
  return negative ? `-${body}` : body;
}

/** Convert a user-typed decimal amount to smallest units. Throws on garbage. */
export function toStroops(input: string, decimals = DECIMALS): bigint {
  const places = normalizeDecimals(decimals);
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Enter a positive number, for example 2.5");
  }
  const [whole = "0", frac = ""] = trimmed.split(".");
  if (frac.length > places) {
    throw new Error(`At most ${places} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(places) + BigInt(frac.padEnd(places, "0") || "0");
}

/**
 * A smallest-unit amount rendered with its own token's unit, e.g. "0.99 USDC".
 * Every amount on screen goes through this so no page can end up labelling an
 * amount with a token it is not denominated in.
 */
export function formatAmount(
  raw: string | bigint,
  meta: TokenMeta = XLM,
  maxFractionDigits = 4,
): string {
  return `${fromStroops(raw, maxFractionDigits, meta.decimals)} ${meta.symbol}`;
}

/**
 * What a form should say about the amount a merchant typed.
 *
 * `toStroops` throws, which is the right behaviour for a transaction path and
 * the wrong one for a live form: a half-typed "1." must read as "keep going",
 * not as a failure. This returns the reason instead so the field can disable
 * the submit button and explain itself without a round trip through an
 * exception.
 */
export type AmountCheck =
  | { ok: true; stroops: bigint }
  | { ok: false; message: string };

/**
 * Validate a user-typed amount without throwing.
 *
 * Accepts a partially typed number such as "1." — the trailing dot is what a
 * numeric keypad leaves behind mid-entry — but rejects anything that could not
 * be read back as a price: signs, exponents, thousands separators, letters.
 * Zero is rejected because the contract's `InvalidAmount` rejects it too, and a
 * merchant who discovers that on-chain has paid a fee for nothing.
 *
 * `decimals` matches `toStroops`: a SEP-41 token picks its own scale, so a
 * 6-decimal token must be refused at the 7th place, not the 6th.
 */
export function checkAmount(input: string, decimals = DECIMALS, locale?: string): AmountCheck {
  const places = normalizeDecimals(decimals);
  const trimmed = input.trim();
  if (trimmed === "") {
    return { ok: false, message: "Enter an amount." };
  }
  // Accept the separators the user's locale uses ("1,234.5", "1.234,5"),
  // then apply the strict dot-decimal rules below to the canonical form.
  // A trailing mark ("1.") canonicalises unchanged, so an unfinished entry
  // still passes exactly as it did before locale parsing existed.
  const canonical = canonicalAmount(trimmed, locale);
  if (canonical === null || !/^\d+(\.\d*)?$/.test(canonical)) {
    return { ok: false, message: "Enter a positive number, for example 2.5." };
  }
  const [whole = "0", frac = ""] = canonical.split(".");
  if (frac.length > places) {
    return { ok: false, message: `At most ${places} decimal places.` };
  }
  const stroops = BigInt(whole) * 10n ** BigInt(places) + BigInt(frac.padEnd(places, "0") || "0");
  if (stroops <= 0n) {
    return { ok: false, message: "Amount must be greater than zero." };
  }
  return { ok: true, stroops };
}

/** Basis points in a percent. Mirrors BPS_DENOMINATOR in the subscription contract. */
export const BPS_DENOMINATOR = 10_000n;

/** Mirrors MAX_FEE_BPS in the subscription contract: at most 10%. */
export const MAX_FEE_BPS = 1_000;

export interface FeeSplit {
  /** What the subscriber is charged, in the token's smallest unit. */
  gross: bigint;
  /** The protocol's cut, also debited from the subscriber's vault. */
  fee: bigint;
  /** What reaches the merchant. `gross - fee`, exactly as the contract computes it. */
  net: bigint;
}

/**
 * Split an amount the way `charge` does in the subscription contract:
 * `fee = amount * fee_bps / 10_000` in integer division, then
 * `merchant_amount = amount - fee`.
 *
 * All three are bigint. Multiplying a stroop amount by a percent in floating
 * point is how a preview ends up promising a tenth of a stroop more than the
 * contract pays out — and a merchant who reconciles against the chain would see
 * it on the very first charge.
 *
 * The rate is clamped to `[0, MAX_FEE_BPS]`, the range the contract's
 * `set_fee_bps` accepts. A malformed value from a stale API or a bad read would
 * otherwise produce a negative payout in a preview that is supposed to
 * reassure.
 */
export function feeSplit(amount: bigint, feeBps: number): FeeSplit {
  const bps = Number.isFinite(feeBps)
    ? BigInt(Math.min(MAX_FEE_BPS, Math.max(0, Math.trunc(feeBps))))
    : 0n;
  const fee = (amount * bps) / BPS_DENOMINATOR;
  return { gross: amount, fee, net: amount - fee };
}

/** A basis-point rate as a readable percentage, e.g. 100 → "1%", 250 → "2.5%". */
export function formatFeeBps(feeBps: number): string {
  if (!Number.isFinite(feeBps) || feeBps <= 0) return "0%";
  const scaled = (feeBps * 100) / 10_000;
  // Basis points are integers, so the fraction is always exact in decimal.
  const text = scaled.toFixed(2).replace(/\.?0+$/, "");
  return `${text}%`;
}

const PERIODS: Array<[string, number]> = [
  ["minute", 60],
  ["hour", 3_600],
  ["day", 86_400],
  ["week", 604_800],
  ["month", 2_592_000],
  ["year", 31_536_000],
];

export function formatPeriod(seconds: number): string {
  for (let i = PERIODS.length - 1; i >= 0; i -= 1) {
    const entry = PERIODS[i];
    if (!entry) continue;
    const [label, size] = entry;
    if (seconds >= size && seconds % size === 0) {
      const n = seconds / size;
      return n === 1 ? `per ${label}` : `every ${n} ${label}s`;
    }
  }
  return `every ${seconds}s`;
}

export function shortAddress(address: string, size = 4): string {
  if (address.length <= size * 2 + 3) return address;
  return `${address.slice(0, size)}…${address.slice(-size)}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * A calendar date, e.g. "22 Nov 2026".
 *
 * Built from the timestamp's UTC fields with fixed English month names rather
 * than `toLocaleDateString`. The pages are prerendered on a server that is not
 * necessarily in the reader's timezone, so a locale-formatted date renders one
 * way during the build and another after hydration. These pages are static
 * exports: a mismatch there is a permanent console error, not a transient one.
 */
export function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  const d = new Date(unixSeconds * 1000);
  const month = MONTHS[d.getUTCMonth()] ?? "";
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

function relativePhrase(count: number, unit: string, future: boolean): string {
  const text = count === 1 ? `1 ${unit}` : `${count} ${unit}s`;
  return future ? `in ${text}` : `${text} ago`;
}

/**
 * A timestamp as plain-language relative time: "in 3 days", "2 hours ago".
 * The old "in 3d" form is hard to read at a glance; the exact local time
 * belongs in the tooltip, which `TimeAgo` in `src/components/ui.tsx` renders
 * alongside this.
 *
 * `nowMs` is injectable so a caller that already holds its own reference time —
 * a test, or the trial copy composing several timestamps — cannot have the two
 * disagree. Without it, asking "is this in the future?" and then asking "how
 * far?" can straddle a boundary and produce "Free trial ended 3 days ago
 * (in 2 hours)".
 */
export function formatWhen(unixSeconds: number, nowMs: number = Date.now()): string {
  if (!unixSeconds) return "—";
  const delta = unixSeconds * 1000 - nowMs;
  const abs = Math.abs(delta);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return delta >= 0 ? "due now" : "just now";
  if (mins < 60) return relativePhrase(mins, "minute", delta >= 0);
  const hours = Math.round(mins / 60);
  if (hours < 24) return relativePhrase(hours, "hour", delta >= 0);
  const days = Math.round(hours / 24);
  return relativePhrase(days, "day", delta >= 0);
}

/**
 * The same instant at its exact local time, e.g. "19 Oct 2026, 14:05", for
 * the tooltip that accompanies a relative time.
 */
export function formatExactTime(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * The `.`-decimal canonical form of a user-typed amount, or `null` when the
 * input is not a single number.
 *
 * Users type the separators their own locale uses: "1,234.5" (dot decimal,
 * comma grouping), "1.234,5" (comma decimal, dot grouping), or just "1,5".
 * The last separator is the decimal mark unless the whole input matches the
 * thousands-grouping pattern, so "1,234" and "1.234.567" are whole grouped
 * numbers — the same disambiguation spreadsheet and banking software use.
 * Earlier separators must then be valid grouping ("1.2.3" is rejected).
 */
export function canonicalAmount(input: string, locale?: string): string | null {
  const stripped = input.replace(/[\s\u00a0\u202f]/g, "");
  if (!stripped || !/^[\d.,]+$/.test(stripped)) return null;
  // French commas are decimal marks even when exactly three digits follow.
  // Dot-decimal keyboard input remains supported; grouping is unambiguous with spaces.
  if (locale?.toLowerCase().startsWith("fr")) {
    if (/^\d*(?:[.,]\d*)?$/.test(stripped) && /\d/.test(stripped)) return stripped.replace(",", ".");
    if (/^\d{1,3}(?:\.\d{3})+,\d*$/.test(stripped)) return stripped.replace(/\./g, "").replace(",", ".");
    return null;
  }

  // With an explicit English locale a dot is always decimal, including 1.234.
  // Preserve historical separator inference for callers without a locale.
  if (locale?.toLowerCase().startsWith("en") && /^\d+(?:\.\d*)?$/.test(stripped)) return stripped;

  // "1,234" / "1.234.567": every separator groups thousands, none is decimal.
  if (/^\d{1,3}([.,]\d{3})+$/.test(stripped)) {
    return stripped.replace(/[.,]/g, "");
  }

  const last = Math.max(stripped.lastIndexOf("."), stripped.lastIndexOf(","));
  if (last === -1) return stripped;
  const head = stripped.slice(0, last);
  const tail = stripped.slice(last + 1);
  // The part before the decimal mark may only group thousands.
  if (!/^(?:\d{1,3}(?:[.,]\d{3})*|\d+)?$/.test(head) || !/^\d*$/.test(tail)) {
    return null;
  }
  return `${head.replace(/[.,]/g, "") || "0"}.${tail}`;
}

/**
 * Locale-aware sibling of `toStroops`: accepts the separators the user's
 * locale uses and normalises them before the strict parser runs, so
 * "1.234,5" and "1,234.5" both convert to the same bigint. Amounts must stay
 * bigint end to end — no step here touches `Number`.
 */
export function parseAmount(input: string, decimals = DECIMALS, locale?: string): bigint {
  const canonical = canonicalAmount(input, locale);
  if (canonical === null) {
    throw new Error("Enter a positive number, for example 2.5");
  }
  return toStroops(canonical, decimals);
}

/**
 * Restrict what an amount field displays: digits plus at most one decimal
 * mark (either character — users type what their keyboard has). Grouping
 * separators typed before the last mark are kept verbatim so "1,234."
 * stays "1,234." while the user keeps typing.
 *
 * The fraction is deliberately *not* truncated to the token's decimals.
 * Silently dropping digits changes the amount the user asked for without
 * saying so; the extra places stay visible and `amountError` explains that
 * the token cannot represent them. Exported for `AmountInput` and its tests.
 */
export function normaliseAmountInput(raw: string): string {
  const stripped = raw.replace(/[\s\u00a0\u202f]/g, "");
  const last = Math.max(stripped.lastIndexOf("."), stripped.lastIndexOf(","));
  if (last === -1) return stripped.replace(/\D/g, "");
  const head = stripped.slice(0, last).replace(/[^\d.,]/g, "");
  const mark = stripped[last];
  const frac = stripped.slice(last + 1).replace(/\D/g, "");
  return frac ? `${head}${mark}${frac}` : `${head}${mark}`;
}

/**
 * Why an amount field cannot be submitted, or `null` when it can — including
 * when it is empty or the user is mid-keystroke on a trailing separator.
 */
export function amountError(input: string, decimals = DECIMALS, locale?: string): string | null {
  const stripped = input.replace(/[\s\u00a0\u202f]/g, "");
  if (!stripped) return null;
  // A bare trailing separator ("12.", ",") is someone still typing, not a
  // mistake yet; anything else must parse cleanly before the form submits.
  if (/^\d+[.,]$|^[.,]$/.test(stripped)) return null;
  try {
    parseAmount(stripped, decimals, locale);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The Unix time a date picker's `YYYY-MM-DD` means: midnight UTC on that day.
 *
 * A date with no time in it is ambiguous, and a mandate's resume has to read
 * the same to everyone looking at it, so this is pinned to UTC rather than the
 * viewer's timezone. "Pause until 2026-10-25" therefore resumes at the start
 * of the 25th.
 */
export function parsePauseDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year = "", month = "", day = ""] = match;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day));
  // Date.UTC rolls 31 February over into March, so check it came back whole.
  const back = new Date(ms);
  if (back.getUTCFullYear() !== Number(year)) return null;
  if (back.getUTCMonth() !== Number(month) - 1) return null;
  if (back.getUTCDate() !== Number(day)) return null;
  return Math.floor(ms / 1000);
}

/**
 * The earliest date a pause can run until, as a date picker value: tomorrow.
 *
 * Today cannot be chosen because a date means midnight UTC, which has already
 * passed by the time the transaction lands.
 */
export function minPauseDate(now: number = Date.now()): string {
  return new Date(now + 86_400_000).toISOString().slice(0, 10);
}

/**
 * A resume timestamp as a calendar date, or null when there is no future
 * resume to show. Returned as `YYYY-MM-DD` rather than a locale string so the
 * page does not disagree with itself between readers.
 */
export function resumeDate(unixSeconds: number | null, now: number = Date.now()): string | null {
  if (unixSeconds === null || !Number.isFinite(unixSeconds)) return null;
  const at = unixSeconds * 1000;
  if (at <= now) return null;
  return new Date(at).toISOString().slice(0, 10);
}
