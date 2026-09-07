import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ShadowMindRuntime } from "../src/runtime.js";
import { parseShadowMarkdown } from "../src/registry.js";
import type { ShadowRunResult } from "../src/shadow-runner.js";
import type { ShadowDefinition, ShadowReport } from "../src/types.js";
import { zeroUsage } from "../src/usage.js";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
type Command = (args: string, ctx: ExtensionContext) => Promise<void>;
interface Internals {
  active: Map<string, { shadow: ShadowDefinition; epoch: number }>;
  panelVisible: boolean;
  configStore: { initialize: () => Promise<void> };
  registry: { initialize: () => Promise<void> };
  usageStore: { add: () => Promise<void>; initialize: () => Promise<void>; flush: () => Promise<void> };
  latestContext?: ExtensionContext;
  sessionLifetime: { activate: () => void; deactivate: () => void };
  registerUi: () => void;
  registerEvents: () => void;
  refresh: () => Promise<{ shadows: []; diagnostics: [] }>;
  statusLines: () => string[];
  deliverReports: (reports: ShadowReport[]) => Promise<void>;
  handleRunEnd: (id: string, shadow: ShadowDefinition, result: ShadowRunResult) => void;
}
const shadow = parseShadowMarkdown("---\nid: reviewer\n---\nReview", "reviewer.md");
function report(runId = "report-run", content = "REPORT_BODY"): ShadowReport {
  return { runId, content, shadowId: shadow.id, shadowName: shadow.name, epoch: 0 };
}
function harness(mode: ExtensionContext["mode"] = "tui") {
  let command: Command | undefined;
  let viewer: Component | undefined;
  let closed = 0;
  const handlers = new Map<string, Handler>();
  const terminal = { rows: 24 };
  const requestRender = vi.fn();
  const setWidget = vi.fn();
  const sendMessage = vi.fn();
  const notify = vi.fn();
  const custom = vi.fn((factory: (tui: TUI, theme: Theme, keys: unknown, done: () => void) => Component) =>
    new Promise<void>((resolve) => {
      viewer = factory({ terminal, requestRender } as unknown as TUI,
        { fg: (_color: string, text: string) => text } as Theme, {}, () => { closed++; resolve(); });
    }),
  );
  const runtime = new ShadowMindRuntime({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (_name: string, definition: { handler: Command }) => { command = definition.handler; },
    registerShortcut: vi.fn(), registerMessageRenderer: vi.fn(), appendEntry: vi.fn(), sendMessage,
  } as unknown as ExtensionAPI);
  const internal = runtime as unknown as Internals;
  internal.usageStore.add = vi.fn().mockResolvedValue(undefined);
  internal.usageStore.initialize = vi.fn().mockResolvedValue(undefined);
  internal.usageStore.flush = vi.fn().mockResolvedValue(undefined);
  internal.configStore.initialize = vi.fn().mockResolvedValue(undefined);
  internal.registry.initialize = vi.fn().mockResolvedValue(undefined);
  internal.refresh = vi.fn().mockResolvedValue({ shadows: [], diagnostics: [] });
  internal.registerUi();
  internal.registerEvents();
  internal.sessionLifetime.activate();
  const ctx = { mode, hasUI: mode === "tui" || mode === "rpc", ui: { custom, setWidget, setStatus: vi.fn(), notify }, isIdle: () => true } as unknown as ExtensionContext;
  internal.latestContext = ctx;
  function complete(id: string, reason: ShadowRunResult["reason"]) {
    internal.active.set(id, { shadow, epoch: 0 });
    internal.handleRunEnd(id, shadow, { reason, durationMs: 1, toolNames: [], missingTools: [], toolCalls: 0, toolFailures: 0, toolStats: [], usage: zeroUsage() });
  }
  return {
    internal, ctx, setWidget, sendMessage, notify, custom, complete, terminal, requestRender,
    command: (args: string) => command!(args, ctx),
    event: (name: string, event: unknown) => handlers.get(name)!(event, ctx),
    render: (width = 80) => viewer!.render(width),
    input: (data: string) => viewer!.handleInput!(data),
    closed: () => closed,
  };
}

describe("delivered reports through the runtime command and real viewer", () => {
  it("opens directly from a closed panel and retains reports after silent runs", async () => {
    const h = harness();
    h.complete("report-run", "report");
    await h.internal.deliverReports([report()]);
    for (let i = 0; i < 5; i++) h.complete(`silent-${i}`, "silent");
    const pending = h.command("reports");
    expect(h.custom).toHaveBeenCalledOnce();
    expect(h.render().join("\n")).toContain("REPORT_BODY");
    expect(h.internal.panelVisible).toBe(false);
    expect(h.internal.statusLines().join("\n")).not.toContain("REPORT_BODY");
    expect(h.custom).toHaveBeenCalledWith(expect.any(Function), {
      overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", margin: 1 },
    });
    expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: "shadow-report", content: expect.stringContaining("REPORT_BODY"),
    }), { triggerTurn: true, deliverAs: "followUp" });
    h.input("\x1b");
    await pending;
    expect(h.closed()).toBe(1);
  });

  it("bounds long reports and makes every line reachable by scrolling", async () => {
    const h = harness();
    await h.internal.deliverReports([report("long", Array.from({ length: 200 }, (_, i) => `BODY_LINE_${i}_END`).join("\r\n"))]);
    const pending = h.command("reports");
    const seen = new Set<string>();
    for (let page = 0; page < 30; page++) {
      const lines = h.render();
      expect(lines.length).toBeLessThanOrEqual(19);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(80);
        for (const match of line.matchAll(/BODY_LINE_\d+_END/g)) seen.add(match[0]);
      }
      h.input("\x1b[6~"); // PageDown
    }
    expect(seen.size).toBe(200);
    h.input("\x1b[H"); // Home
    expect(h.render().join("\n")).toContain("BODY_LINE_0_END");
    h.input("\x1b[F"); // End
    expect(h.render().join("\n")).toContain("BODY_LINE_199_END");
    await h.command("reports hide");
    await pending;
    expect(h.requestRender).toHaveBeenCalled();
  });

  it("adapts width and height on resize and preserves the report tail", async () => {
    const h = harness();
    await h.internal.deliverReports([report("wide", `${"中文🙂".repeat(150)}\nFINAL_MARKER`)]);
    const pending = h.command("reports");
    for (const [rows, width] of [[24, 80], [8, 12], [4, 3], [30, 100]]) {
      h.terminal.rows = rows;
      const lines = h.render(width);
      expect(lines.length).toBeLessThanOrEqual(Math.floor(rows * 0.8));
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    h.input("\x1b[F");
    expect(h.render(100).join("\n")).toContain("FINAL_MARKER");
    h.input("\x1b");
    await pending;
  });

  it("lists only the five newest deliveries even when run records have expired", async () => {
    const h = harness();
    await h.internal.deliverReports(Array.from({ length: 7 }, (_, i) => report(`run-${i}`, `REPORT_${i}`)));
    const pending = h.command("reports");
    const output = h.render().join("\n");
    expect(output).toContain("REPORT_6");
    expect(output).not.toContain("REPORT_0");
    h.input("\x1b[F");
    expect(h.render().join("\n")).toContain("REPORT_2");
    await h.command("reports"); // repeat closes without stacking another view
    await pending;
    expect(h.custom).toHaveBeenCalledOnce();
  });

  it.each(["new", "resume", "reload", "fork"])("clears and closes report views on %s session replacement", async (reason) => {
    const h = harness();
    await h.internal.deliverReports([report()]);
    const pending = h.command("reports");
    await h.event("session_shutdown", { reason });
    await pending;
    expect(h.closed()).toBe(1);
    await h.event("session_start", { reason });
    await h.command("reports");
    expect(h.custom).toHaveBeenCalledOnce();
    expect(h.notify).toHaveBeenLastCalledWith("No reports delivered in this session yet.", "info");
  });

  it("does not retain rejected epochs or reports from an inactive session", async () => {
    const h = harness();
    await h.internal.deliverReports([{ ...report(), epoch: -1 }]);
    h.internal.sessionLifetime.deactivate();
    await h.internal.deliverReports([report()]);
    await h.command("reports");
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.custom).not.toHaveBeenCalled();
  });

  it("does not retain a report when sending throws", async () => {
    const h = harness();
    h.sendMessage.mockImplementationOnce(() => { throw new Error("send failed"); });
    await expect(h.internal.deliverReports([report()])).rejects.toThrow("send failed");
    await h.command("reports");
    expect(h.custom).not.toHaveBeenCalled();
  });

  it("reports empty/invalid commands without opening or leaking an old view", async () => {
    const h = harness();
    await h.command("reports");
    expect(h.notify).toHaveBeenLastCalledWith("No reports delivered in this session yet.", "info");
    await h.command("reports unexpected");
    expect(h.notify).toHaveBeenLastCalledWith("Usage: /shadow reports [hide]", "warning");
    await h.command("reports hide");
    expect(h.custom).not.toHaveBeenCalled();
    await h.internal.deliverReports([report()]);
    const first = h.command("reports");
    h.input("\x1b");
    await first;
    const second = h.command("reports");
    expect(h.render().join("\n")).toContain("REPORT_BODY");
    h.input("\x1b");
    await second;
    expect(h.closed()).toBe(2);
  });

  it.each(["rpc", "json", "print"] as const)("does not invoke TUI factories in %s mode", async (mode) => {
    const h = harness(mode);
    await h.internal.deliverReports([report()]);
    await h.command("reports");
    expect(h.custom).not.toHaveBeenCalled();
  });
});
