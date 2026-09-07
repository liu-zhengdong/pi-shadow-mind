import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, type Component, type KeyId } from "@earendil-works/pi-tui";
import type { DeliveredReport } from "./report-history.js";

interface ViewerHost {
  rows(): number;
  requestRender(): void;
  close(): void;
}

/** A bounded viewport over complete report text; scrolling never edits history. */
export class ReportViewer implements Component {
  private readonly body: Text;
  private offset = 0;
  private contentHeight = 0;
  private pageSize = 1;
  private readonly actions: ReadonlyArray<readonly [KeyId, () => void]>;

  constructor(reports: readonly DeliveredReport[], private readonly theme: Pick<Theme, "fg">, private readonly host: ViewerHost) {
    this.body = new Text(reports.map((report) =>
      `${report.shadowName} · ${report.deliveredAt}\nrun ${report.runId}\n${report.content.replace(/\r\n?/g, "\n")}`,
    ).join("\n\n"), 0, 0);
    this.actions = [
      ["escape", () => host.close()],
      ["up", () => this.scroll(-1)],
      ["down", () => this.scroll(1)],
      ["pageUp", () => this.scroll(-this.pageSize)],
      ["pageDown", () => this.scroll(this.pageSize)],
      ["home", () => { this.offset = 0; }],
      ["end", () => { this.offset = this.maxOffset(); }],
    ];
  }

  render(width: number): string[] {
    // Match the overlay's 80% height ceiling, including title and controls.
    const height = Math.max(1, Math.min(Math.floor(this.host.rows() * 0.8), this.host.rows() - 2));
    this.pageSize = Math.max(1, height - 2);
    const lines = this.body.render(Math.max(1, width));
    this.contentHeight = lines.length;
    this.offset = Math.min(this.offset, this.maxOffset());
    const page = lines.slice(this.offset, this.offset + this.pageSize);
    if (height < 3) return page.slice(0, height).map((line) => truncateToWidth(line, width));
    return [
      this.theme.fg("accent", truncateToWidth("Recent Shadow reports · newest first", width)),
      ...page,
      this.theme.fg("dim", truncateToWidth(
        `Esc close · ↑↓ PgUp/PgDn Home/End · ${this.offset + 1}–${Math.min(this.offset + this.pageSize, lines.length)}/${lines.length}`, width,
      )),
    ];
  }

  handleInput(data: string): void {
    const action = this.actions.find(([key]) => matchesKey(data, key));
    if (!action) return;
    action[1]();
    this.host.requestRender();
  }

  invalidate(): void {
    this.body.invalidate();
  }

  private maxOffset(): number {
    return Math.max(0, this.contentHeight - this.pageSize);
  }

  private scroll(lines: number): void {
    this.offset = Math.max(0, Math.min(this.maxOffset(), this.offset + lines));
  }
}
