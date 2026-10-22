"use client";

import { useI18n } from "@/i18n/provider";

import { useEffect, useRef, type ReactNode } from "react";
import { canonicalAmount, normaliseAmountInput } from "@/lib/format";

/**
 * A decimal amount field for money.
 *
 * Users in locales with comma decimals get errors from a field that only
 * accepts `1234.5`, so this field takes what their keyboard produces —
 * `1,234.5`, `1.234,5`, `1,5` — and all of them parse to the same bigint
 * stroops through `parseAmount` at submit time. While typing, the field is
 * filtered to digits plus at most one separator; a fraction longer than the
 * token's decimals stays visible and is reported as an error rather than
 * silently truncated, because dropping digits changes the amount.
 *
 * The parent page owns the raw string state and reads the bigint back with
 * `parseAmount(value, decimals)` (or `checkAmount`) when the user submits.
 */
export function AmountInput({
  id,
  label,
  value,
  onChange,
  decimals,
  placeholder,
  disabled = false,
  hint,
  hideError = false,
  describedBy,
  onBlur,
}: {
  id: string;
  label: ReactNode;
  /** Raw field text, e.g. "1,234.5". Owned by the parent. */
  value: string;
  onChange: (next: string) => void;
  /** The token's decimals: values above this many places are reported. */
  decimals: number;
  placeholder?: string;
  disabled?: boolean;
  /** Static help text under the field, shown alongside any error. */
  hint?: ReactNode;
  /**
   * Suppress the inline message when the form renders its own (e.g. a fee
   * preview that doubles as the error slot). The field keeps filtering and
   * stays aria-invalid.
   */
  hideError?: boolean;
  /** Extra id for `aria-describedby`, e.g. the form's own message element. */
  describedBy?: string;
  onBlur?: () => void;
}) {
  const { locale, amountError, t: tr, translateMessage } = useI18n();
  const previousLocale = useRef(locale);
  useEffect(() => {
    if (previousLocale.current === locale) return;
    const canonical = canonicalAmount(value, previousLocale.current);
    previousLocale.current = locale;
    // Keep the exact amount while changing its decimal mark. Do not alter invalid drafts.
    if (canonical !== null) {
      const next = locale === "fr" ? canonical.replace(".", ",") : canonical;
      if (next !== value) onChange(next);
    }
  }, [locale, value, onChange]);
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const message = amountError(value, decimals);
  const described = [
    describedBy ?? "",
    hint ? hintId : "",
    !hideError && message ? errorId : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div>
      <label className="label" htmlFor={id}>
        {typeof label === "string" ? tr(label) : label}
      </label>
      <input
        id={id}
        className="input"
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        aria-invalid={message ? true : undefined}
        aria-describedby={described || undefined}
        onChange={(e) => onChange(normaliseAmountInput(e.target.value))}
        onBlur={onBlur}
      />
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-muted">
          {typeof hint === "string" ? tr(hint) : hint}
        </p>
      )}
      {!hideError && message && (
        <p id={errorId} className="mt-1 text-sm text-danger">
          {translateMessage(message)}
        </p>
      )}
    </div>
  );
}
