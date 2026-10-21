"use client";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import * as money from "@/lib/format";
import * as localized from "./format";
import { presentation } from "./presentation";
import { createTranslation, translateMessage } from "./translate";
export const LOCALE_STORAGE_KEY = "payflow.locale";
export const isLocale = (value: unknown): value is localized.Locale => value === "en" || value === "fr";
function makeValue(locale: localized.Locale, setLocale: (value: localized.Locale) => void) {
  return {
    ...presentation(locale),
    formatTokenValue: (raw: string | bigint, digits?: number, decimals?: number) => localized.formatTokenValue(raw, locale, digits, decimals),
    formatUsdString: (value: string) => localized.formatUsdString(value, locale),
    locale, localeTag: localized.localeTag(locale), setLocale, t: createTranslation(locale),
    translateMessage: (value: string) => translateMessage(locale, value),
    formatNumber: (value: number | bigint) => localized.formatNumber(value, locale),
    formatAmount: (raw: string | bigint, meta?: money.TokenMeta, digits?: number) => localized.formatAmount(raw, locale, meta, digits),
    formatDate: (seconds: number) => localized.formatDate(seconds, locale),
    formatExactTime: (seconds: number) => localized.formatExactTime(seconds, locale),
    formatWhen: (seconds: number, now?: number) => localized.formatWhen(seconds, locale, now),
    formatPeriod: (seconds: number) => localized.formatPeriod(seconds, locale),
    formatFeeBps: (bps: number) => localized.formatFeeBps(bps, locale),
    parseAmount: (input: string, decimals?: number) => money.parseAmount(input, decimals, localized.localeTag(locale)),
    checkAmount: (input: string, decimals?: number) => money.checkAmount(input, decimals, localized.localeTag(locale)),
    amountError: (input: string, decimals?: number) => money.amountError(input, decimals, localized.localeTag(locale)),
  };
}
const Context = createContext(makeValue("en", () => {}));
export function I18nProvider({ children }: { children: ReactNode }) {
  // The initial render always matches the English static export. Restore only after hydration.
  const [locale, setLocaleState] = useState<localized.Locale>("en");
  useEffect(() => {
    try { const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY); if (isLocale(saved)) setLocaleState(saved); } catch { /* In-memory selection still works. */ }
    function onStorage(event: StorageEvent) {
      if (event.key === LOCALE_STORAGE_KEY || event.key === null) setLocaleState(isLocale(event.newValue) ? event.newValue : "en");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = createTranslation(locale)("Payflow — recurring payments on Stellar");
  }, [locale]);
  const value = useMemo(() => makeValue(locale, next => {
    if (!isLocale(next)) return;
    setLocaleState(next);
    try { window.localStorage.setItem(LOCALE_STORAGE_KEY, next); } catch { /* Storage is optional. */ }
  }), [locale]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useI18n() { return useContext(Context); }
