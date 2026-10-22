"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  formatRetentionPercent,
  parseCohortRetention,
  retentionColorClass,
  type CohortRetentionData,
} from "@/lib/cohort-retention";
import { Empty, Notice, Panel, SkeletonRows } from "./ui";

type CohortRetentionState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "error" }
  | { status: "data"; data: CohortRetentionData };

interface CohortRetentionTableProps {
  merchant: string;
  apiConfigured: boolean;
}

export function CohortRetentionTable({ merchant, apiConfigured }: CohortRetentionTableProps) {
  const [state, setState] = useState<CohortRetentionState>({ status: "loading" });

  useEffect(() => {
    if (!apiConfigured) {
      setState({ status: "unavailable" });
      return;
    }

    let live = true;
    setState({ status: "loading" });
    void api
      .merchantCohortRetention(merchant)
      .then((body) => {
        if (!live) return;
        if (body === null) {
          setState({ status: "unavailable" });
          return;
        }
        const data = parseCohortRetention(body, merchant);
        setState(data === null ? { status: "error" } : { status: "data", data });
      })
      .catch(() => {
        if (live) setState({ status: "unavailable" });
      });

    return () => {
      live = false;
    };
  }, [apiConfigured, merchant]);

  return (
    <Panel
      title="Cohort retention"
      subtitle="Percentage of each signup month's subscribers still active in subsequent months. Higher percentages indicate better retention."
    >
      {!apiConfigured ? (
        <Notice tone="info">
          Cohort retention analysis requires the payflow backend. Configure NEXT_PUBLIC_API_URL
          to enable this report; contract-only mode does not retain historical signup and churn
          data needed for cohort tracking.
        </Notice>
      ) : state.status === "loading" ? (
        <SkeletonRows rows={3} label="Loading cohort retention data" />
      ) : state.status === "unavailable" ? (
        <Empty title="Cohort retention analysis unavailable">
          The payflow backend is not reachable or does not serve this report yet. Contract state
          cannot reconstruct historical cohort retention data.
        </Empty>
      ) : state.status === "error" ? (
        <Notice tone="error">
          The backend returned an incomplete or inconsistent cohort retention report, so these
          metrics are hidden rather than shown as misleading data.
        </Notice>
      ) : state.data.cohorts.length === 0 ? (
        <Empty title="No cohort data available">
          No signup cohorts were returned for this merchant. Cohort retention requires at least
          one month of subscription history.
        </Empty>
      ) : (
        <div
          className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          role="region"
          aria-label="Cohort retention table"
          tabIndex={0}
        >
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Cohort retention: percentage of subscribers from each signup month still active after
              0, 1, 2, ... months
            </caption>
            <thead>
              <tr className="border-b border-edge text-muted">
                <th scope="col" className="sticky left-0 bg-panel py-2 pr-3 font-medium z-10">
                  Signup month
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Cohort size
                </th>
                {Array.from({ length: state.data.maxAge + 1 }, (_, i) => (
                  <th key={i} scope="col" className="py-2 px-2 text-center font-medium min-w-[4rem]">
                    {i === 0 ? "Month 0" : `+${i}m`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.data.cohorts.map((cohort) => (
                <tr key={cohort.cohort} className="border-b border-edge last:border-0">
                  <th scope="row" className="sticky left-0 bg-panel py-2 pr-3 font-medium z-10">
                    {cohort.cohort}
                  </th>
                  <td className="py-2 pr-3 text-right tabular-nums">{cohort.size}</td>
                  {Array.from({ length: state.data.maxAge + 1 }, (_, monthIndex) => {
                    const percent = cohort.retention[monthIndex];
                    return (
                      <td
                        key={monthIndex}
                        className={`py-2 px-2 text-center tabular-nums ${
                          percent !== undefined ? retentionColorClass(percent) : ""
                        }`}
                      >
                        {percent !== undefined ? (
                          <span aria-label={`${percent}% retained after ${monthIndex} months`}>
                            {formatRetentionPercent(percent)}
                          </span>
                        ) : (
                          <span className="text-muted" aria-label="Data not yet available">
                            —
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
