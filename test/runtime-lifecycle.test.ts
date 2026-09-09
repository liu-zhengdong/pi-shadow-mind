import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReportBatcher } from "../src/report-batcher.js";
import { ShadowMindRuntime } from "../src/runtime.js";
import type { ShadowRunResult } from "../src/shadow-runner.js";
import type {
  RegistrySnapshot,
  ShadowDefinition,
} from "../src/types.js";
import { zeroUsage, type ShadowUsage } from "../src/usage.js";

type EventHandler = (event: unknown, context: ExtensionContext) => unknown;

interface RuntimeInternals {
  active: Map<string, { shadow: ShadowDefinition; epoch: number }>;
  epoch: number;
  recentRuns: unknown[];
  sessionUsage: ShadowUsage;
  usageStore: {
    add: (usage: ShadowUsage) => Promise<void>;
  };
  completionReview: {
    schedule: (...args: unknown[]) => boolean;
    invalidate: () => void;
  };
  runner: {
    run: (...args: unknown[]) => Promise<ShadowRunResult>;
  };
  batcher: ReportBatcher;
  refresh: (ctx: ExtensionContext) => Promise<RegistrySnapshot>;
  onFinalResponse: (ctx: ExtensionContext) => Promise<void>;
  finalResponseRounds: Map<string, number>;
  registerEvents: () => void;
  onHeartbeat: (ctx: ExtensionContext, executedTools: ReadonlySet<string>) => Promise<void>;
  recentEvents: Array<{ kind: string; data?: Record<string, unknown> }>;
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
  activationTools: [],
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
    getAllTools: () => [],
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

  it("does not consume a round for an invalidated queued final review", async () => {
    const { internals } = createRuntimeHarness();
    const finalShadow = { ...shadow, trigger: ["final_response"] as const, activeForModels: ["openai/gpt"], finalResponseRounds: 1 };
    internals.refresh = vi.fn().mockResolvedValue({
      shadows: [finalShadow],
      diagnostics: [],
    });
    internals.active.set("heartbeat-a", { shadow, epoch: 0 });
    internals.active.set("heartbeat-b", { shadow, epoch: 0 });
    const context = {
      model: { provider: "openai", id: "gpt" },
      getSystemPrompt: () => "",
      sessionManager: {
        getEntries: () => [],
        getLeafId: () => null,
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext;

    await internals.onFinalResponse(context);
    expect(internals.finalResponseRounds.get(finalShadow.id)).toBeUndefined();

    internals.completionReview.invalidate();
    await internals.onFinalResponse(context);

    expect(internals.recentEvents.at(-1)?.data?.activated).toEqual([finalShadow.id]);
  });

  it("does not consume a round if review is invalidated while running", async () => {
    const { internals } = createRuntimeHarness();
    const finalShadow = {
      ...shadow,
      trigger: ["final_response"] as const,
      activeForModels: ["openai/gpt"],
      finalResponseRounds: 1,
    };
    internals.refresh = vi.fn().mockResolvedValue({
      shadows: [finalShadow],
      diagnostics: [],
    });
    internals.runner.run = vi.fn(
      () => new Promise<ShadowRunResult>(() => undefined),
    );
    const context = {
      model: { provider: "openai", id: "gpt" },
      getSystemPrompt: () => "",
      sessionManager: {
        getEntries: () => [],
        getLeafId: () => null,
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext;

    await internals.onFinalResponse(context);
    expect(internals.finalResponseRounds.get(finalShadow.id)).toBeUndefined();

    internals.completionReview.invalidate();
    await internals.onFinalResponse(context);

    expect(internals.recentEvents.at(-1)?.data?.activated).toEqual([
      finalShadow.id,
    ]);
  });

  it("flushes pending reports and skips scheduling when batcher has pending reports", async () => {
    const { internals } = createRuntimeHarness();
    const finalShadow = {
      ...shadow,
      trigger: ["final_response"] as const,
      activeForModels: ["openai/gpt"],
      finalResponseRounds: 1,
    };
    internals.refresh = vi.fn().mockResolvedValue({
      shadows: [finalShadow],
      diagnostics: [],
    });
    const schedule = vi.spyOn(internals.completionReview, "schedule");
    internals.batcher.add({
      shadowId: "heartbeat",
      shadowName: "heartbeat",
      content: "issue found",
      epoch: 0,
      runId: "run-hb",
    });
    expect(internals.batcher.hasPending).toBe(true);

    const context = {
      model: { provider: "openai", id: "gpt" },
      getSystemPrompt: () => "",
      sessionManager: {
        getEntries: () => [],
        getLeafId: () => null,
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext;

    await internals.onFinalResponse(context);

    expect(schedule).not.toHaveBeenCalled();
    expect(internals.batcher.hasPending).toBe(false);
  });

  it("limits final-response rounds per Shadow until new user input", async () => {
    const { handlers, internals } = createRuntimeHarness();
    const finalShadow = { ...shadow, trigger: ["final_response"] as const, activeForModels: ["openai/gpt"], finalResponseRounds: 1 };
    internals.refresh = vi.fn().mockResolvedValue({
      shadows: [finalShadow],
      diagnostics: [],
    });
    internals.runner.run = vi.fn().mockResolvedValue({
      shadowId: finalShadow.id,
      reason: "silent",
      durationMs: 10,
      usage: zeroUsage(),
    });
    const schedule = vi.spyOn(internals.completionReview, "schedule");
    internals.registerEvents();
    const context = {
      model: { provider: "openai", id: "gpt" },
      getSystemPrompt: () => "",
      sessionManager: {
        getEntries: () => [],
        getLeafId: () => null,
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext;
    const finalEvent = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
      ],
    };

    await handlers.get("agent_end")!(finalEvent, context);
    await handlers.get("agent_settled")!({}, context);
    await handlers.get("agent_end")!(finalEvent, context);
    await handlers.get("agent_settled")!({}, context);

    expect(schedule.mock.calls.filter(([, jobs]) => (jobs as unknown[]).length > 0)).toHaveLength(1);

    handlers.get("input")!({ source: "interactive" }, context);
    await handlers.get("agent_end")!(finalEvent, context);
    await handlers.get("agent_settled")!({}, context);

    expect(schedule.mock.calls.filter(([, jobs]) => (jobs as unknown[]).length > 0)).toHaveLength(2);
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

  it("skips text-only turns and forwards completed tool names for refreshed evaluation", async () => {
    const { handlers, internals } = createRuntimeHarness();
    internals.onHeartbeat = vi.fn();
    internals.registerEvents();
    const turnEnd = handlers.get("turn_end")!;
    const context = {} as ExtensionContext;

    await turnEnd({ toolResults: [] }, context);
    expect(internals.onHeartbeat).not.toHaveBeenCalled();
    expect(internals.recentEvents.at(-1)?.data?.reason).toBe("no-tool-activity");

    await turnEnd({ toolResults: [{ toolName: "read" }, { toolName: "bash" }, { toolName: "read" }] }, context);
    expect(internals.onHeartbeat).toHaveBeenCalledExactlyOnceWith(context, new Set(["read", "bash"]));
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
