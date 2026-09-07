import type { ShadowReport } from "./types.js";

export interface DeliveredReport extends ShadowReport {
  deliveredAt: string;
}

/** Session-local delivery history, independent of silent/completed runs. */
export class ReportHistory {
  private reports: DeliveredReport[] = [];

  constructor(private readonly limit = 5) {
    if (!Number.isInteger(limit) || limit < 0) throw new Error("Report limit must be a non-negative integer");
  }

  add(reports: readonly ShadowReport[], deliveredAt = new Date().toISOString()): void {
    for (const report of reports) {
      this.reports = this.reports.filter(({ runId }) => runId !== report.runId);
      this.reports.push({ ...report, deliveredAt });
      if (this.reports.length > this.limit) this.reports.shift();
    }
  }

  /** Newest delivery first; callers receive an isolated snapshot. */
  list(): DeliveredReport[] {
    return this.reports.map((report) => ({ ...report })).reverse();
  }

  clear(): void {
    this.reports = [];
  }
}
