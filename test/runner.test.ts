import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { ShadowRunner, type ShadowRunRequest } from "../src/shadow-runner.js";

// ---------------------------------------------------------------------------
// Mock only createAgentSession; everything else (pre-checks, bootstrap, report
// tool, metrics, result building) runs for real. The fake session faithfully
// simulates the AgentSession surface the runner depends on.
// ---------------------------------------------------------------------------

const mock = vi.hoisted(() => {
  class FakeSession {
    messages: Record<string, unknown>[] = [
      // Simulates the injected main-session trajectory (tool results present).
      {
        role: "toolResult",
        toolName: "read",
        isError: false,
        toolCallId: "traj-1",
      },
      {
        role: "toolResult",
        toolName: "grep",
        isError: false,
        toolCallId: "traj-2",
      },
    ];
    sessionFile = "/tmp/fake/session.jsonl";
    aborted = false;
    disposed = false;
    behavior: "silent" | "report" | "tools" | "throw" | "hang" = "silent";
    promptError: Error | undefined;
    options: any;
    private release?: (err?: Error) => void;

    constructor(options: any) {
      this.options = options;
    }

    getActiveToolNames(): string[] {
      return (this.options.tools ?? []).filter(
        (name: string) => !name.startsWith("missing-"),
      );
    }

    async prompt(): Promise<void> {
      if (this.behavior === "hang") {
        this.messages.push({
          role: "assistant",
          usage: {
            input: 5,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 8,
            cost: {
              input: 0.005,
              output: 0.003,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.008,
            },
          },
        });
        await new Promise<void>((resolve, reject) => {
          this.release = (err) => (err ? reject(err) : resolve());
        });
        return;
      }
      if (this.behavior === "throw") {
        this.messages.push({
          role: "assistant",
          usage: {
            input: 2,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: {
              input: 0.002,
              output: 0.001,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.003,
            },
          },
        });
        throw this.promptError ?? new Error("prompt failed");
      }
      if (this.behavior === "report") {
        // Simulate the model calling the (real) built-in report_to_main tool.
        const reportTool = this.options.customTools?.find(
          (tool: any) => tool.name === "report_to_main",
        );
        await reportTool.execute(
          "call-1",
          { content: "found a smell" },
          undefined,
          undefined,
          {} as any,
        );
        return;
      }
      if (this.behavior === "tools") {
        // Shadow's own tool calls, appended after the trajectory.
        this.messages.push({
          role: "assistant",
          usage: {
            input: 10,
            output: 20,
            cacheRead: 30,
            cacheWrite: 40,
            totalTokens: 100,
            cost: {
              input: 0.01,
              output: 0.02,
              cacheRead: 0.03,
              cacheWrite: 0.04,
              total: 0.1,
            },
          },
        });
        this.messages.push({
          role: "toolResult",
          toolName: "write",
          isError: false,
          toolCallId: "own-1",
        });
        this.messages.push({
          role: "assistant",
          usage: {
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            totalTokens: 10,
            cost: {
              input: 0.001,
              output: 0.002,
              cacheRead: 0.003,
              cacheWrite: 0.004,
              total: 0.01,
            },
          },
        });
        this.messages.push({
          role: "toolResult",
          toolName: "write",
          isError: true,
          toolCallId: "own-2",
        });
      }
    }

    async waitForIdle(): Promise<void> {}

    abort(): void {
      this.aborted = true;
      this.release?.(new Error("aborted"));
    }

    dispose(): void {
      this.disposed = true;
    }
  }
  return {
    FakeSession,
    sessions: [] as FakeSession[],
    createAgentSession: vi.fn(),
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: mock.createAgentSession };
});

const fakeModel = {
  provider: "test",
  id: "model",
  api: "openai-completions",
  baseUrl: "http://test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
  thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high" },
} as any;

let tmp: string;
let behavior: InstanceType<typeof mock.FakeSession>["behavior"] = "silent";
let promptError: Error | undefined;

function makeRequest(
  overrides: Partial<ShadowRunRequest> = {},
): ShadowRunRequest {
  return {
    shadow: {
      id: "s",
      name: "S",
      enabled: true,
      debug: false,
      activationProbability: 0.5,
      trigger: ["heartbeat"],
      activeForModels: ["*"],
      tools: [],
      activationTools: [],
      prompt: "test",
      filePath: "s.md",
    },
    config: {
      heartbeatProbability: 1 / 3,
      heartbeatTools: [],
      maxParallelShadows: 2,
      defaultShadowTimeoutSeconds: 60,
      headlessDrainTimeoutSeconds: 120,
      resultBatchWindowMs: 400,
      defaultThinkingLevel: "low",
    },
    epoch: 1,
    runId: "run-1",
    cwd: tmp,
    agentDir: tmp,
    mainSystemPrompt: "system prompt",
    messages: [],
    mainModel: fakeModel,
    tools: ["read", "report_to_main"],
    resolveModel: () => fakeModel,
    modelAuthOk: () => true,
    mainThinkingLevel: "high",
    onReport: vi.fn(),
    ...overrides,
  };
}

describe("ShadowRunner.run integration", () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shadow-test-"));
    behavior = "silent";
    promptError = undefined;
    mock.sessions.length = 0;
    mock.createAgentSession.mockReset();
    mock.createAgentSession.mockImplementation(async (options: any) => {
      const session = new mock.FakeSession(options);
      session.behavior = behavior;
      session.promptError = promptError;
      mock.sessions.push(session);
      return { session, extensionsResult: {} as any };
    });
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("runs silently: no report, empty metrics, session disposed", async () => {
    const runner = new ShadowRunner();
    const onReport = vi.fn();
    const result = await runner.run(makeRequest({ onReport }));
    expect(result.reason).toBe("silent");
    expect(result.toolCalls).toBe(0);
    expect(result.toolStats).toEqual([]);
    expect(result.sessionFile).toBe("/tmp/fake/session.jsonl");
    expect(onReport).not.toHaveBeenCalled();
    expect(mock.sessions[0].disposed).toBe(true);
  });

  it("delivers a report through the real report_to_main tool and ends the run", async () => {
    const runner = new ShadowRunner();
    const onReport = vi.fn();
    behavior = "report";
    const result = await runner.run(makeRequest({ onReport }));
    const session = mock.sessions[0];
    expect(result.reason).toBe("report");
    expect(result.thinkingLevel).toBe("high");
    expect(onReport).toHaveBeenCalledWith(
      expect.objectContaining({
        shadowId: "s",
        shadowName: "S",
        content: "found a smell",
        epoch: 1,
        runId: "run-1",
      }),
    );
    expect(session.aborted).toBe(true);
    expect(session.disposed).toBe(true);
  });

  it("counts each own assistant/tool round, excluding the injected trajectory", async () => {
    const runner = new ShadowRunner();
    behavior = "tools";
    const result = await runner.run(makeRequest());
    expect(result.reason).toBe("silent");
    expect(result.toolCalls).toBe(2);
    expect(result.toolFailures).toBe(1);
    expect(result.toolStats).toEqual([
      { tool: "write", calls: 2, failures: 1 },
    ]);
    expect(result.usage).toEqual({
      requests: 2,
      input: 11,
      output: 22,
      cacheRead: 33,
      cacheWrite: 44,
      totalTokens: 110,
      cost: {
        input: 0.011,
        output: 0.022,
        cacheRead: 0.033,
        cacheWrite: 0.044,
        total: 0.11,
      },
    });
  });

  it("reports missing tools that did not materialize in the session", async () => {
    const runner = new ShadowRunner();
    const result = await runner.run(
      makeRequest({ tools: ["read", "missing-x", "report_to_main"] }),
    );
    expect(result.missingTools).toEqual(["missing-x"]);
  });

  it("resolves the thinking level with fallback and passes it to createAgentSession", async () => {
    const runner = new ShadowRunner();
    const result = await runner.run(
      makeRequest({
        shadow: { ...makeRequest().shadow, thinkingLevel: "medium" },
      }),
    );
    expect(result.thinkingLevel).toBe("high");
    expect(mock.sessions[0].options.thinkingLevel).toBe("high");
  });

  it("times out: aborts the session and returns timeout without reporting", async () => {
    const runner = new ShadowRunner();
    const onReport = vi.fn();
    behavior = "hang";
    const result = await runner.run(
      makeRequest({
        onReport,
        config: { ...makeRequest().config, defaultShadowTimeoutSeconds: 0.05 },
      }),
    );
    const session = mock.sessions[0];
    expect(result.reason).toBe("timeout");
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.usage).toMatchObject({
      requests: 1,
      totalTokens: 8,
      cost: { total: 0.008 },
    });
    expect(session.aborted).toBe(true);
    expect(onReport).not.toHaveBeenCalled();
  });

  it("propagates prompt errors as run errors", async () => {
    const runner = new ShadowRunner();
    behavior = "throw";
    promptError = new Error("boom");
    const result = await runner.run(makeRequest());
    const session = mock.sessions[0];
    expect(result.reason).toBe("error");
    expect(result.error).toBe("boom");
    expect(result.usage).toMatchObject({
      requests: 1,
      totalTokens: 3,
      cost: { total: 0.003 },
    });
    expect(session.disposed).toBe(true);
  });

  it("reports aborted when the run is cancelled externally", async () => {
    const runner = new ShadowRunner();
    behavior = "hang";
    const pending = runner.run(makeRequest({ runId: "run-abort" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    runner.abort("run-abort");
    const result = await pending;
    const session = mock.sessions[0];
    expect(result.reason).toBe("aborted");
    expect(session.aborted).toBe(true);
    expect(result.toolCalls).toBe(0);
    expect(result.usage).toMatchObject({
      requests: 1,
      totalTokens: 8,
      cost: { total: 0.008 },
    });
  });
});
