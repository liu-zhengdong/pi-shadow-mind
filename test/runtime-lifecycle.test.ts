import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShadowMindRuntime } from "../src/runtime.js";
import type { ShadowRunResult } from "../src/shadow-runner.js";
import type {
  RegistrySnapshot,
  ShadowDefinition,
  ShadowReport,
} from "../src/types.js";
import { zeroUsage, type ShadowUsage } from "../src/usage.js";

type EventHandler = (event: unknown, context: ExtensionContext) => unknown;

interface RuntimeInternals {
  active: Map<string, { shadow: ShadowDefinition; epoch: number }>;
  epoch: number;
  recentRuns: Array<{
    runId: string;
    shadowName: string;
    completedAt: string;
    result: ShadowRunResult;
  }>;
  reportHistory: {
    add: (reports: readonly ShadowReport[]) => void;
  };
  reportsVisible: boolean;
  panelVisible: boolean;
  statusLines: () => string[];
  registerUi: () => void;
  deliverReports: (reports: readonly ShadowReport[]) => Promise<void>;
  sessionLifetime: { activate: () => void };
  latestContext?: ExtensionContext;
  sessionUsage: ShadowUsage;
  usageStore: {
    add: (usage: ShadowUsage) => Promise<void>;
  };
  completionReview: {
    schedule: (...args: unknown[]) => boolean;
  };
  refresh: (ctx: ExtensionContext) => Promise<RegistrySnapshot>;
  registerEvents: () => void;
  handleRunEnd: (
    runId: string,
    shadow: ShadowDefinition,
    result: ShadowRunResult,
  ) => void;
}

const shadow: ShadowDefinition = {
  id: "shadow-1",
  name: "Review",
  enabled: true,
  debug: false,
  activationProbability: 1,
  trigger: ["heartbeat"],
  activeForModels: [],
  tools: [],
  prompt: "Review",
  filePath: "review.md",
};

afterEach(() => {
  vi.useRealTimers();
});

function createRuntimeHarness() {
  const handlers = new Map<string, EventHandler>();
  const runtime = new ShadowMindRuntime({
    on: (name: string, handler: EventHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI);
  const internals = runtime as unknown as RuntimeInternals;
  return { handlers, internals };
}

describe("ShadowMindRuntime session lifecycle", () => {
  it.each(["reload", "new", "resume", "fork"])(
    "bounds %s session shutdown and detaches an unsettled old run",
    async (reason) => {
      vi.useFakeTimers();
      const { handlers, internals } = createRuntimeHarness();
      internals.active.set("old-run", { shadow, epoch: 0 });
      internals.registerEvents();

      const context = {
        mode: "interactive",
        ui: {
          setStatus: vi.fn(),
          setWidget: vi.fn(),
        },
      } as unknown as ExtensionContext;
      const shutdown = handlers.get("session_shutdown");
      expect(shutdown).toBeDefined();

      const pending = shutdown!({ reason }, context);
      await vi.advanceTimersByTimeAsync(999);
      expect(internals.active.size).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(internals.active.size).toBe(0);
    },
  );

  it("runs final-response scheduling only after final assistant text", async () => {
    const { handlers, internals } = createRuntimeHarness();
    internals.refresh = vi.fn().mockResolvedValue({
      shadows: [],
      diagnostics: [],
    });
    internals.registerEvents();
    const agentEnd = handlers.get("agent_end");
    const agentSettled = handlers.get("agent_settled");
    const context = {} as ExtensionContext;

    await agentEnd!(
      {
        messages: [
          { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
        ],
      },
      context,
    );
    await agentSettled!({}, context);
    expect(internals.refresh).not.toHaveBeenCalled();

    await agentEnd!(
      {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "Done." }] },
        ],
      },
      context,
    );
    expect(internals.refresh).not.toHaveBeenCalled();
    await agentSettled!({}, context);
    expect(internals.refresh).toHaveBeenCalledOnce();
  });

  it("abandons a final-review start superseded by new input during refresh", async () => {
    const { handlers, internals } = createRuntimeHarness();
    let finishRefresh: ((snapshot: RegistrySnapshot) => void) | undefined;
    internals.refresh = vi.fn(
      () =>
        new Promise<RegistrySnapshot>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const schedule = vi.spyOn(internals.completionReview, "schedule");
    internals.registerEvents();
    const context = {} as ExtensionContext;

    await handlers.get("agent_end")!(
      {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "Done." }] },
        ],
      },
      context,
    );
    const pending = handlers.get("agent_settled")!(
      {},
      context,
    ) as Promise<void>;
    handlers.get("input")!({ source: "interactive" }, context);
    finishRefresh!({ shadows: [], diagnostics: [] });
    await pending;

    expect(schedule).not.toHaveBeenCalled();
  });

  it("persists a stale run without adding it to the new session quota", async () => {
    const runtime = new ShadowMindRuntime({} as ExtensionAPI);
    const internals = runtime as unknown as RuntimeInternals;
    const persisted: ShadowUsage[] = [];
    internals.usageStore.add = async (usage) => {
      persisted.push(usage);
    };
    internals.epoch = 2;
    internals.active.set("old-run", { shadow, epoch: 1 });
    const usage = zeroUsage();
    usage.requests = 1;
    usage.input = 42;
    usage.totalTokens = 42;

    internals.handleRunEnd("old-run", shadow, runResult(usage));

    expect(persisted).toEqual([usage]);
    expect(internals.sessionUsage).toEqual(zeroUsage());
    expect(internals.recentRuns).toHaveLength(0);
  });
  it("shows and hides delivered report content in the status panel", async () => {
    let commandHandler:
      | ((args: string, ctx: ExtensionContext) => unknown)
      | undefined;
    const runtime = new ShadowMindRuntime({
      registerCommand: (_name: string, definition: { handler: typeof commandHandler }) => {
        commandHandler = definition.handler;
      },
      registerShortcut: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
      appendEntry: vi.fn(),
    } as unknown as ExtensionAPI);
    const internals = runtime as unknown as RuntimeInternals;
    internals.registerUi();
    internals.recentRuns.push(
      {
        runId: "run-old",
        shadowName: "Old Review",
        completedAt: new Date().toISOString(),
        result: runResult(zeroUsage()),
      },
      {
        runId: "run-1",
        shadowName: "Latest Review",
        completedAt: new Date().toISOString(),
        result: runResult(zeroUsage()),
      },
    );
    const context = {
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      },
      isIdle: vi.fn().mockReturnValue(true),
    } as unknown as ExtensionContext;
    internals.latestContext = context;
    internals.panelVisible = true;
    internals.sessionLifetime.activate();
    await internals.deliverReports([
      {
        shadowId: "shadow-1",
        shadowName: "Review",
        content: "line one\nline two",
        epoch: 0,
        runId: "run-1",
      },
    ]);

    expect(internals.statusLines()).not.toContain("    line one");
    await commandHandler!("reports show", context);
    expect(internals.statusLines()).toContain("    line one");
    expect(context.ui.setWidget).toHaveBeenLastCalledWith(
      "shadow-mind-panel",
      expect.any(Function),
      { placement: "aboveEditor" },
    );
    expect(internals.statusLines()).toContain("    line two");
    expect(internals.statusLines().findIndex((line) => line === "    line one"))
      .toBeGreaterThan(
        internals.statusLines().findIndex((line) => line.includes("· Old Review ·")),
      );

    await commandHandler!("reports hide", context);
    expect(internals.statusLines()).not.toContain("    line one");
    await commandHandler!("reports", context);
    expect(internals.statusLines()).toContain("    line one");
    await commandHandler!("reports", context);
    expect(internals.statusLines()).not.toContain("    line one");
  });
});

function runResult(usage: ShadowUsage): ShadowRunResult {
  return {
    reason: "aborted",
    durationMs: 100,
    toolNames: [],
    missingTools: [],
    toolCalls: 0,
    toolFailures: 0,
    toolStats: [],
    usage,
  };
}
