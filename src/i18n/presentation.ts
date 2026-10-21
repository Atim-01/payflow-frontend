import type { ApiMandate } from "@/lib/api";
import { trialEndsAt, trialSeconds, trialBadge as englishTrialBadge, type HasTrial } from "@/lib/trial";
import { discountBps, discountCharges, type HasDiscount } from "@/lib/discount";
import { bestPoint, totalNet, describeSeries as englishDescribeSeries, type BucketSize, type RevenuePoint } from "@/lib/revenue";
import { createTranslation } from "./translate";
import * as f from "./format";

/** Display adapters only: contract values and financial calculations remain canonical. */
export function presentation(locale: f.Locale) {
  const t = createTranslation(locale);
  function formatTrialLength(seconds: number): string {
    const units = [[86_400, "day"], [3_600, "hour"], [60, "minute"], [1, "second"]] as const;
    const [size, unit] = units.find(([size]) => seconds >= size && seconds % size === 0) ?? units[3];
    const count = seconds / size;
    return new Intl.NumberFormat(f.localeTag(locale), { style: "unit", unit, unitDisplay: "long" }).format(count);
  }
  function discountLabel(bps: number, charges: number) {
    const percent = f.formatFeeBps(bps, locale);
    return charges === 1 ? t("{0} off the next charge", { 0: percent }) : t("{0} off for {1} charges", { 0: percent, 1: charges });
  }
  return {
    formatTrialLength,
    trialBadge: (plan: HasTrial | null | undefined) => locale === "en" ? englishTrialBadge(plan) : trialSeconds(plan) ? t("Free trial: {0}", { 0: formatTrialLength(trialSeconds(plan)) }) : null,
    describeTrialEnd: (mandate: Pick<ApiMandate, "charges_made" | "next_charge" | "status" | "trial">, now = Math.floor(Date.now() / 1000)) => {
      const ends = trialEndsAt(mandate);
      return ends === null ? null : t(ends <= now ? "Free trial ended {0} ({1})" : "Free trial ends {0} ({1})", { 0: f.formatDate(ends, locale), 1: f.formatWhen(ends, locale, now * 1000) });
    },
    discountBadge: (source: HasDiscount | null | undefined) => discountBps(source) && discountCharges(source) ? discountLabel(discountBps(source), discountCharges(source)) : null,
    discountLabel,
    unitLabel: (unit: { name: string }) => t(unit.name === "week" ? "Weeks" : unit.name === "month" ? "Months" : "Days"),
    formatBucketLabel: (start: number) => new Intl.DateTimeFormat(f.localeTag(locale), { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(start * 1000)),
    bucketTitle: (start: number, size: BucketSize) => size === "week" ? t("Week of {0}", { 0: f.formatDate(start, locale) }) : f.formatDate(start, locale),
    describeSeries: (points: RevenuePoint[], size: BucketSize, render: (value: bigint) => string) => {
      if (locale === "en") return englishDescribeSeries(points, size, render);
      if (!points.length) return t("No revenue recorded in this period.");
      const best = bestPoint(points);
      const range = t("Net revenue by {0}, from {1} to {2}, total {3}.", { 0: t(size === "week" ? "week" : "day"), 1: f.formatDate(points[0]!.start, locale), 2: f.formatDate(points[points.length - 1]!.start, locale), 3: render(totalNet(points)) });
      return best && best.net > 0n ? range + " " + t("Peak {0} on {1}.", { 0: render(best.net), 1: f.formatDate(best.start, locale) }) : range;
    },
  };
}
