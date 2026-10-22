/**
 * One cohort in the retention grid: a signup month and how many subscribers
 * from that cohort remained active in each subsequent month.
 */
export interface CohortRetentionRow {
  /** Signup month in YYYY-MM format. */
  cohort: string;
  /** Number of subscribers who signed up in this month. */
  size: number;
  /**
   * Retention percentages for months 0, 1, 2, ... since signup.
   * Month 0 is the signup month itself (always 100%).
   * Each subsequent entry is the percentage still subscribed.
   */
  retention: number[];
}

/**
 * The full cohort retention analysis from the backend.
 */
export interface CohortRetentionData {
  merchant: string;
  cohorts: CohortRetentionRow[];
  /** The maximum age (in months) any cohort has been tracked. */
  maxAge: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMonth(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
  const [year, month] = value.split("-").map(Number);
  return year !== undefined && year > 0 && month !== undefined && month >= 1 && month <= 12;
}

function isValidPercentage(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function parseCohort(value: unknown): CohortRetentionRow | null {
  if (!isRecord(value)) return null;
  const { cohort, size, retention } = value;
  
  if (!isMonth(cohort)) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
  if (!Array.isArray(retention)) return null;
  
  // Validate all retention percentages
  for (const pct of retention) {
    if (!isValidPercentage(pct)) return null;
  }
  
  // Month 0 (signup month) should always be 100% if present
  if (retention.length > 0 && retention[0] !== 100) return null;
  
  return {
    cohort,
    size,
    retention: retention as number[],
  };
}

/**
 * Parse the backend's cohort retention response, or return null if it cannot
 * be safely represented.
 *
 * The backend returns cohorts (signup months) with their sizes and retention
 * percentages for each month since signup. We validate the structure and
 * ensure all percentages are in [0, 100] and that month 0 is always 100%.
 */
export function parseCohortRetention(
  body: unknown,
  merchant: string,
): CohortRetentionData | null {
  if (!isRecord(body) || body.merchant !== merchant || !Array.isArray(body.cohorts)) {
    return null;
  }

  const cohorts: CohortRetentionRow[] = [];
  const seen = new Set<string>();
  let maxAge = 0;

  for (const row of body.cohorts) {
    const cohort = parseCohort(row);
    if (cohort === null) return null;
    
    // No duplicate cohorts
    if (seen.has(cohort.cohort)) return null;
    seen.add(cohort.cohort);
    
    cohorts.push(cohort);
    maxAge = Math.max(maxAge, cohort.retention.length - 1);
  }

  // Sort chronologically (oldest first)
  cohorts.sort((a, b) => a.cohort.localeCompare(b.cohort));

  return {
    merchant,
    cohorts,
    maxAge,
  };
}

/**
 * Format a retention percentage for display.
 * Returns "100%" for perfect retention, "0%" for complete churn,
 * and removes unnecessary decimal places otherwise.
 */
export function formatRetentionPercent(value: number): string {
  if (value === 0) return "0%";
  if (value === 100) return "100%";
  // Show up to 1 decimal place, removing trailing zeros
  return `${value.toFixed(1).replace(/\.0$/, "")}%`;
}

/**
 * Generate a CSS background color for a retention cell based on the percentage.
 * Higher retention gets darker/more saturated colors.
 * Returns a Tailwind-compatible class or inline style hint.
 */
export function retentionColorClass(percent: number): string {
  if (percent >= 90) return "bg-green-100 dark:bg-green-950";
  if (percent >= 70) return "bg-green-50 dark:bg-green-900/50";
  if (percent >= 50) return "bg-yellow-50 dark:bg-yellow-900/50";
  if (percent >= 30) return "bg-orange-50 dark:bg-orange-900/50";
  if (percent > 0) return "bg-red-50 dark:bg-red-900/50";
  return "bg-gray-50 dark:bg-gray-900/50";
}
