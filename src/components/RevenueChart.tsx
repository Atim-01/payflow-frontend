"use client";

import { useI18n } from "@/i18n/provider";

import { useId, useMemo } from "react";
import type { TokenMeta } from "@/lib/format";
import { scaleSeries, toPolyline, totalNet, type BucketSize, type RevenuePoint } from "@/lib/revenue";

/**
 * Net revenue over time, drawn with plain SVG.
 *
 * No charting library: this is one polyline, and a dependency that ships its
 * own colours would fight the dark palette in `globals.css` rather than follow
 * it. Colours come from the same accent and edge tokens as everything else, so
 * the chart follows the theme rather than hardcoding hex values.
 *
 * Two things a chart must not be:
 *
 * - Unreadable without sight. The `svg` carries an accessible name summarising
 *   the range, total and peak, and the same numbers are available as a real
 *   `<table>` behind a disclosure — a table, not a `div` grid, so a screen
 *   reader can associate the header with each figure.
 * - Imprecise. Every amount is a bigint in the token's smallest unit from the
 *   API to the pixel, and the table prints the same figures the line encodes.
 */

const WIDTH = 640;
const HEIGHT = 180;
const PADDING = 6;

export function RevenueChart({
  points,
  size,
  meta,
}: {
  points: RevenuePoint[];
  size: BucketSize;
  meta: TokenMeta;
}) {
  const { formatAmount, t: tr, describeSeries, formatBucketLabel, bucketTitle } = useI18n();
  const tableId = useId();
  const scaled = useMemo(
    () => scaleSeries(points, WIDTH, HEIGHT, PADDING),
    [points],
  );
  const render = useMemo(() => (value: bigint) => formatAmount(value, meta), [meta, formatAmount]);
  const summary = describeSeries(points, size, render);
  const allZero = points.length > 0 && totalNet(points) === 0n;

  // At most five labels on the axis: one per pixel column would be unreadable
  // and a screen reader would announce every one of them.
  const labelStride = Math.max(1, Math.ceil(points.length / 5));

  return (
    <div className="space-y-3">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-44 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
      >
        <line
          x1={0}
          x2={WIDTH}
          y1={HEIGHT - PADDING}
          y2={HEIGHT - PADDING}
          className="stroke-edge"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {scaled.length > 0 && (
          <polyline
            points={toPolyline(scaled)}
            fill="none"
            className="stroke-accent"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {scaled.length > 0 && (
        <div className="flex justify-between text-xs text-muted" aria-hidden="true">
          {points.map((p, i) =>
            i % labelStride === 0 || i === points.length - 1 ? (
              <span key={p.start}>{formatBucketLabel(p.start)}</span>
            ) : null,
          )}
        </div>
      )}

      {allZero && (
        <p className="text-sm text-muted">{tr("No charges settled in this period, so there is nothing to plot. The table below still lists every bucket.")}</p>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer text-muted hover:text-fg">{tr("Show revenue as a table")}</summary>
        <div className="mt-3 overflow-x-auto" id={tableId}>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{summary}</caption>
            <thead>
              <tr className="border-b border-edge text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  {size === "week" ?tr("Week of") :tr("Day")}
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">{tr("Charged")}</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">{tr("Fee")}</th>
                <th scope="col" className="py-1.5 text-right font-medium">{tr("You received")}</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {points.map((p) => (
                <tr key={p.start} className="border-b border-edge/60 last:border-0">
                  <th scope="row" className="py-1.5 pr-3 font-normal" title={bucketTitle(p.start, size)}>
                    {formatBucketLabel(p.start)}
                  </th>
                  <td className="py-1.5 pr-3 text-right">{render(p.gross)}</td>
                  <td className="py-1.5 pr-3 text-right text-muted">{render(p.fee)}</td>
                  <td className="py-1.5 text-right">{render(p.net)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-edge font-medium">
                <th scope="row" className="py-1.5 pr-3 text-left font-medium">{tr("Total")}</th>
                <td className="sr-only" colSpan={2} />
                <td className="py-1.5 text-right">{render(totalNet(points))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </details>
    </div>
  );
}