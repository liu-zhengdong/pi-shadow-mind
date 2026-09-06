import type { ShadowReport } from "./types.js";

export class ReportHistory {
  private reports: ShadowReport[] = [];

  constructor(private readonly limit: () => number) {}

  add(reports: readonly ShadowReport[]): void {
    for (const report of reports) {
      this.reports = this.reports.filter(({ runId }) => runId !== report.runId);
      this.reports.push(report);
    }
    this.trim();
  }

  forRun(runId: string): ShadowReport | undefined {
    return this.reports.find((report) => report.runId === runId);
  }

  clear(): void {
    this.reports = [];
  }

  private trim(): void {
    const limit = Math.max(0, this.limit());
    if (this.reports.length > limit) this.reports.splice(0, this.reports.length - limit);
  }
}
