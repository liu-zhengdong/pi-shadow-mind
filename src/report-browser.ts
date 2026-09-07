import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ReportHistory } from "./report-history.js";
import { ReportViewer } from "./report-viewer.js";
import type { ShadowReport } from "./types.js";

/** Owns report retention and the report command/view lifecycle. */
export class ReportBrowser {
  private readonly history = new ReportHistory();
  private closeViewer?: () => void;

  add(reports: readonly ShadowReport[]): void {
    this.history.add(reports);
  }

  reset(): void {
    this.closeViewer?.();
    this.history.clear();
  }

  async handleCommand(command: string, ctx: ExtensionContext): Promise<boolean> {
    const [name, ...args] = command.split(/\s+/);
    if (name !== "reports") return false;
    if (args.length && args.join(" ") !== "hide") {
      ctx.ui.notify("Usage: /shadow reports [hide]", "warning");
      return true;
    }
    if (args[0] === "hide" || this.closeViewer) {
      this.closeViewer?.();
      return true;
    }
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.notify("The report viewer requires TUI mode. Delivered reports remain in the conversation.", "warning");
      return true;
    }
    const reports = this.history.list();
    if (!reports.length) {
      ctx.ui.notify("No reports delivered in this session yet.", "info");
      return true;
    }
    const view = { close: () => {} };
    try {
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        view.close = () => {
          if (this.closeViewer !== view.close) return;
          this.closeViewer = undefined;
          done();
        };
        this.closeViewer = view.close;
        return new ReportViewer(reports, theme, {
          rows: () => tui.terminal.rows,
          requestRender: () => tui.requestRender(),
          close: view.close,
        });
      }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", margin: 1 } });
    } finally {
      if (this.closeViewer === view.close) this.closeViewer = undefined;
    }
    return true;
  }
}
