import { randomUUID } from "node:crypto";
import {
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";
import {
  CompletionReview,
  type CompletionReviewRun,
} from "./completion-review.js";
import { ConfigStore } from "./config.js";
import { EntityStore } from "./entity-store.js";
import { registerManagementTools } from "./management-tools.js";
import { ShadowRegistry } from "./registry.js";
import { ReportBatcher, formatReportBatch } from "./report-batcher.js";
import { createRandom } from "./random.js";
import { applyAcpCompressionProjection } from "./acp-projection.js";
import {
  decideFinalResponse,
  decideHeartbeat,
  shouldEvaluateFinalResponse,
  shouldEvaluateHeartbeat,
} from "./scheduler.js";
import { SessionLifetime } from "./session-lifetime.js";
import {
  ShadowRunner,
  resolveShadowTools,
  type ShadowRunResult,
} from "./shadow-runner.js";
import { waitForSettled } from "./shutdown-drain.js";
import type {
  RegistrySnapshot,
  RuntimeEvent,
  ShadowDefinition,
  ShadowReport,
} from "./types.js";
import { UsageStore } from "./usage-store.js";
import {
  addUsage,
  formatUsageCost,
  formatUsageDetail,
  formatUsageSummary,
  formatUsageTokens,
  zeroUsage,
  type ShadowUsage,
} from "./usage.js";

const SESSION_TEARDOWN_TIMEOUT_MS = 1_000;

type SessionContext = ReturnType<typeof buildSessionContext>;
interface ShadowLaunch {
  ctx: ExtensionContext;
  shadow: ShadowDefinition;
  mainModel: Model<any>;
  fullModelId: string;
  context: SessionContext;
  availableTools: Set<string>;
  epoch?: number;
  completionReview?: CompletionReviewRun;
}
interface ActiveRun {
  shadow: ShadowDefinition;
  epoch: number;
  completionReview?: CompletionReviewRun;
}

interface PendingFinalRun extends Omit<ShadowLaunch, "completionReview"> {
  epoch: number;
  shadowId: string;
}

export class ShadowMindRuntime {
  private readonly agentDir = getAgentDir();
  private readonly configStore = new ConfigStore(this.agentDir);
  private readonly registry = new ShadowRegistry(this.agentDir);
  private readonly entityStore = new EntityStore(
    this.registry,
    this.configStore.configPath,
  );
  private readonly runner = new ShadowRunner();
  private readonly usageStore = new UsageStore(this.agentDir);
  private readonly active = new Map<string, ActiveRun>();
  private readonly completionReview = new CompletionReview<PendingFinalRun>({
    currentEpoch: () => this.epoch,
    maxParallel: () => this.configStore.current.maxParallelShadows,
    activeCount: () => this.active.size,
    activeShadowIds: () =>
      new Set([...this.active.values()].map(({ shadow }) => shadow.id)),
    launch: (pending, review) =>
      this.launchShadow({ ...pending, completionReview: review }),
    deliver: (reports) => void this.deliverReports(reports),
  });
  private readonly recentEvents: RuntimeEvent[] = [];
  private readonly recentRuns: Array<{
    shadowName: string;
    completedAt: string;
    result: ShadowRunResult;
  }> = [];
  private readonly batcher: ReportBatcher;
  private readonly sessionLifetime = new SessionLifetime();
  private epoch = 0;
  private modelCalls = 0;
  private paused = false;
  private panelVisible = false;
  private latestContext?: ExtensionContext;
  private diagnostics: string[] = [];
  private sessionUsage: ShadowUsage = zeroUsage();
  private shadowCount = 0;
  private completedWithFinalText = false;
  private random: () => number = Math.random;

  constructor(private readonly pi: ExtensionAPI) {
    this.batcher = new ReportBatcher(
      this.configStore.current.resultBatchWindowMs,
      (reports) => {
        this.completionReview.invalidate();
        void this.deliverReports(reports);
      },
    );
  }

  register(): void {
    registerManagementTools(
      this.pi,
      this.entityStore,
      () => this.configStore.current,
    );
    this.registerEvents();
    this.registerUi();
  }

  private registerEvents(): void {
    this.pi.on("session_start", async (_event, ctx) => {
      this.sessionLifetime.activate();
      this.latestContext = ctx;
      this.modelCalls = 0;
      this.completedWithFinalText = false;
      this.sessionUsage = zeroUsage();
      this.recentRuns.length = 0;
      await this.configStore.initialize();
      await this.usageStore.initialize();
      this.random = createRandom(this.configStore.current.randomSeed);
      await this.registry.initialize();
      await this.refresh(ctx);
      this.record("session-config", {
        randomSeed: this.configStore.current.randomSeed ?? "random",
      });
      this.updateStatus(ctx);
    });

    this.pi.on("input", (event, ctx) => {
      this.latestContext = ctx;
      if (event.source === "extension") return;
      this.completedWithFinalText = false;
      this.epoch += 1;
      this.abortAll("new-user-input");
    });

    this.pi.on("after_provider_response", (_event, ctx) => {
      this.latestContext = ctx;
      this.modelCalls += 1;
    });

    this.pi.on("turn_end", async (event, ctx) => {
      this.latestContext = ctx;
      if (!shouldEvaluateHeartbeat(event.toolResults)) {
        this.record("heartbeat-skipped", {
          reason: "no-tool-activity",
          modelCalls: this.modelCalls,
        });
        return;
      }
      await this.onHeartbeat(ctx);
    });

    this.pi.on("agent_end", (event, ctx) => {
      this.latestContext = ctx;
      this.completedWithFinalText = shouldEvaluateFinalResponse(event.messages);
    });

    this.pi.on("agent_settled", async (_event, ctx) => {
      this.latestContext = ctx;
      if (!this.completedWithFinalText) {
        this.record("final-response-skipped", {
          reason: "no-final-assistant-text",
        });
        return;
      }
      this.completedWithFinalText = false;
      await this.onFinalResponse(ctx);
    });

    this.pi.on("session_shutdown", async (event, ctx) => {
      this.latestContext = ctx;
      if (
        event.reason === "quit" &&
        (ctx.mode === "print" || ctx.mode === "json")
      ) {
        await this.drainHeadless(ctx);
      }
      this.epoch += 1;
      this.abortAll("session-shutdown");
      if (this.active.size > 0) {
        const result = await waitForSettled({
          timeoutMs: SESSION_TEARDOWN_TIMEOUT_MS,
          isSettled: () => this.active.size === 0,
        });
        if (!result.settled) this.active.clear();
      }
      await this.usageStore.flush();
      ctx.ui.setStatus("shadow-mind", undefined);
      ctx.ui.setWidget("shadow-mind-panel", undefined);
      this.sessionLifetime.deactivate();
    });
  }

  private registerUi(): void {
    this.pi.registerCommand("shadow", {
      description: "Show Shadow Mind status, or toggle/pause/resume it",
      handler: async (args, ctx) => {
        this.latestContext = ctx;
        const command = args.trim().toLowerCase();
        if (command === "pause") {
          this.setPaused(true, ctx);
          return;
        }
        if (command === "resume") {
          this.setPaused(false, ctx);
          return;
        }
        if (command === "toggle") {
          this.setPaused(!this.paused, ctx);
          return;
        }
        if (command === "status") {
          await this.refresh(ctx);
          ctx.ui.notify(
            this.statusLines().join("\n"),
            this.diagnostics.length ? "warning" : "info",
          );
        } else if (command === "hide") {
          this.panelVisible = false;
          ctx.ui.setWidget("shadow-mind-panel", undefined);
        } else {
          await this.refresh(ctx);
          this.panelVisible = !this.panelVisible;
        }
        this.updateStatus(ctx);
      },
    });

    this.pi.registerShortcut("alt+s", {
      description: "Pause or resume Shadow Mind",
      handler: (ctx) => {
        this.latestContext = ctx;
        this.setPaused(!this.paused, ctx);
      },
    });

    this.pi.registerMessageRenderer(
      "shadow-report",
      (message, _options, theme) => {
        const content =
          typeof message.content === "string"
            ? message.content
            : "Shadow report";
        const prefix = theme.fg("accent", "🐙 shadow · ");
        return new Text(`${prefix}${content}`, 0, 0);
      },
    );
  }

  private async onHeartbeat(ctx: ExtensionContext): Promise<void> {
    const snapshot = await this.refresh(ctx);
    if (this.paused || !ctx.model) {
      this.record("heartbeat-skipped", {
        reason: this.paused ? "paused" : "no-model",
        modelCalls: this.modelCalls,
      });
      return;
    }
    const fullModelId = `${ctx.model.provider}/${ctx.model.id}`;
    const decision = decideHeartbeat({
      heartbeatProbability: this.configStore.current.heartbeatProbability,
      availableSlots: Math.max(
        0,
        this.configStore.current.maxParallelShadows - this.active.size,
      ),
      shadows: snapshot.shadows,
      activeShadowIds: new Set(
        [...this.active.values()].map(({ shadow }) => shadow.id),
      ),
      mainModelId: fullModelId,
      random: this.random,
    });
    this.record("heartbeat", {
      modelCalls: this.modelCalls,
      roll: decision.heartbeatRoll,
      candidates: decision.candidates,
      activated: decision.activated.map(({ shadow, roll }) => ({
        id: shadow.id,
        roll,
      })),
      ...(decision.modelFiltered.length
        ? { modelFiltered: decision.modelFiltered }
        : {}),
      ...(decision.runningExcluded.length
        ? { runningExcluded: decision.runningExcluded }
        : {}),
    });
    if (!decision.activated.length) return;

    const context = buildSessionContext(
      applyAcpCompressionProjection(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getSessionFile(),
      ),
      ctx.sessionManager.getLeafId(),
    );
    const availableTools = new Set(
      this.pi.getAllTools().map((tool) => tool.name),
    );
    for (const { shadow } of decision.activated) {
      this.launchShadow({
        ctx,
        shadow,
        mainModel: ctx.model,
        fullModelId,
        context,
        availableTools,
      });
    }
  }

  private async onFinalResponse(ctx: ExtensionContext): Promise<void> {
    const request = this.completionReview.begin(this.epoch);
    const snapshot = await this.refresh(ctx);
    if (!this.completionReview.isCurrent(request)) {
      this.record("final-response-skipped", { reason: "superseded" });
      return;
    }
    if (this.paused || !ctx.model) {
      this.completionReview.cancel(request);
      this.record("final-response-skipped", {
        reason: this.paused ? "paused" : "no-model",
      });
      return;
    }
    const mainModel = ctx.model;
    const fullModelId = `${mainModel.provider}/${mainModel.id}`;
    const decision = decideFinalResponse({
      shadows: snapshot.shadows,
      mainModelId: fullModelId,
    });
    this.record("final-response", {
      candidates: decision.candidates,
      activated: decision.activated.map(({ shadow }) => shadow.id),
      ...(decision.modelFiltered.length
        ? { modelFiltered: decision.modelFiltered }
        : {}),
      ...(decision.runningExcluded.length
        ? { runningExcluded: decision.runningExcluded }
        : {}),
    });
    if (!decision.activated.length) {
      this.completionReview.schedule(request, []);
      return;
    }

    const context = buildSessionContext(
      applyAcpCompressionProjection(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getSessionFile(),
      ),
      ctx.sessionManager.getLeafId(),
    );
    const availableTools = new Set(
      this.pi.getAllTools().map((tool) => tool.name),
    );
    this.completionReview.schedule(
      request,
      decision.activated.map(({ shadow }) => ({
        epoch: request.epoch,
        shadowId: shadow.id,
        ctx,
        shadow,
        mainModel,
        fullModelId,
        context,
        availableTools,
      })),
    );
  }

  private launchShadow(options: ShadowLaunch): void {
    const {
      ctx,
      shadow,
      mainModel,
      fullModelId,
      context,
      availableTools,
      completionReview,
    } = options;
    const runId = randomUUID();
    const runEpoch = options.epoch ?? this.epoch;
    const { tools, missing } = resolveShadowTools(shadow.tools, availableTools);
    const activeRun: ActiveRun = { shadow, epoch: runEpoch };
    if (completionReview) activeRun.completionReview = completionReview;
    this.active.set(runId, activeRun);
    this.record("run-start", {
      runId,
      shadowId: shadow.id,
      model:
        shadow.runWithModel ??
        this.configStore.current.defaultShadowModel ??
        fullModelId,
      ...(missing.length ? { missingTools: missing } : {}),
    });
    this.updateStatus(ctx);
    void this.runner
      .run({
        shadow: structuredClone(shadow),
        config: structuredClone(this.configStore.current),
        epoch: runEpoch,
        runId,
        cwd: ctx.cwd,
        agentDir: this.agentDir,
        mainSystemPrompt: ctx.getSystemPrompt(),
        // SAFETY: buildSessionContext returns Pi messages; ShadowRunner treats them as read-only records.
        messages: context.messages as unknown as Record<string, unknown>[],
        mainModel,
        tools,
        resolveModel: (id) => resolveModel(ctx, id),
        modelAuthOk: (model) =>
          ctx.modelRegistry.hasConfiguredAuth(model) ||
          ctx.modelRegistry.isUsingOAuth(model),
        mainThinkingLevel: ctx.thinkingLevel,
        onReport: (report) => {
          if (completionReview) completionReview.accept(report);
          else this.acceptReport(report);
        },
      })
      .then((result) => this.handleRunEnd(runId, shadow, result))
      .catch((error) => {
        const activeRun = this.active.get(runId);
        this.active.delete(runId);
        this.completionReview.slotAvailable();
        this.completionReview.complete(activeRun?.completionReview);
        this.record("run-end", {
          runId,
          shadowId: shadow.id,
          reason: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private handleRunEnd(
    runId: string,
    shadow: ShadowDefinition,
    result: ShadowRunResult,
  ): void {
    const activeRun = this.active.get(runId);
    this.active.delete(runId);
    this.completionReview.slotAvailable();
    const persisted = this.usageStore.add(result.usage);
    if (activeRun?.epoch !== this.epoch) {
      this.completionReview.complete(activeRun?.completionReview);
      return;
    }
    this.sessionUsage = addUsage(this.sessionUsage, result.usage);
    this.recentRuns.push({
      shadowName: shadow.name,
      completedAt: new Date().toISOString(),
      result,
    });
    if (this.recentRuns.length > 5) this.recentRuns.shift();
    this.record("run-end", { runId, shadowId: shadow.id, ...result });
    if (this.latestContext && this.sessionLifetime.isActive)
      this.updateStatus(this.latestContext);
    this.completionReview.complete(activeRun.completionReview);
    void persisted.then(() => {
      if (this.latestContext && this.sessionLifetime.isActive)
        this.updateStatus(this.latestContext);
    });
  }

  private acceptReport(report: ShadowReport): void {
    if (report.epoch !== this.epoch) return;
    this.batcher.add(report);
  }

  private async deliverReports(
    reports: readonly ShadowReport[],
  ): Promise<void> {
    const current = reports.filter((report) => report.epoch === this.epoch);
    if (!current.length) return;
    const content = formatReportBatch(current);
    this.record("report-delivered", {
      runIds: current.map((report) => report.runId),
      count: current.length,
    });
    const idle = this.latestContext?.isIdle() ?? true;
    this.sessionLifetime.run(() => {
      this.pi.sendMessage(
        {
          customType: "shadow-report",
          content,
          display: true,
          details: {
            reports: current.map(({ shadowId, runId }) => ({
              shadowId,
              runId,
            })),
          },
        },
        { triggerTurn: true, deliverAs: idle ? "followUp" : "steer" },
      );
    });
  }

  private async refresh(ctx: ExtensionContext): Promise<RegistrySnapshot> {
    const config = await this.configStore.reload();
    const registry = await this.registry.load();
    this.batcher.setWindow(config.config.resultBatchWindowMs);
    this.shadowCount = registry.shadows.length;
    this.diagnostics = [
      ...(config.error ? [`config: ${config.error}`] : []),
      ...registry.diagnostics.map(
        (item) => `${item.filePath}: ${item.message}`,
      ),
    ];
    this.updateStatus(ctx);
    return registry;
  }

  private abortAll(reason: string): void {
    this.runner.abortAll();
    this.completionReview.invalidate();
    this.batcher.clear();
    this.record("runs-aborted", { reason, count: this.active.size });
  }

  private async drainHeadless(ctx: ExtensionContext): Promise<void> {
    if (this.active.size === 0 && !this.batcher.hasPending) return;
    const timeoutMs =
      this.configStore.current.headlessDrainTimeoutSeconds * 1000;
    this.record("headless-drain-start", {
      timeoutMs,
      active: this.active.size,
    });
    const result = await waitForSettled({
      timeoutMs,
      isSettled: () =>
        this.active.size === 0 &&
        !this.batcher.hasPending &&
        ctx.isIdle() &&
        !ctx.hasPendingMessages(),
    });
    this.record(
      result.settled ? "headless-drain-complete" : "headless-drain-timeout",
      {
        durationMs: result.durationMs,
        active: this.active.size,
      },
    );
    if (!result.settled) this.abortAll("headless-drain-timeout");
  }

  private record(kind: string, data?: Record<string, unknown>): void {
    const event: RuntimeEvent = {
      at: new Date().toISOString(),
      kind,
      epoch: this.epoch,
      data,
    };
    this.recentEvents.push(event);
    if (this.recentEvents.length > 20) this.recentEvents.shift();
    this.sessionLifetime.run(() =>
      this.pi.appendEntry("shadow-mind-event", event),
    );
  }

  private setPaused(paused: boolean, ctx: ExtensionContext): void {
    this.paused = paused;
    if (paused) this.abortAll("paused");
    ctx.ui.notify(
      paused ? "Shadow Mind paused" : "Shadow Mind resumed",
      "info",
    );
    this.updateStatus(ctx);
  }

  private updateStatus(ctx: ExtensionContext): void {
    this.sessionLifetime.run(() => {
      const diagnostics = this.usageStore.error
        ? [...this.diagnostics, `usage: ${this.usageStore.error}`]
        : this.diagnostics;
      const warning =
        diagnostics.length || this.hasRecentRunErrors() ? " !" : "";
      const usage = `${formatUsageTokens(this.sessionUsage.totalTokens)} · ${formatUsageCost(this.sessionUsage.cost.total)}`;
      ctx.ui.setStatus(
        "shadow-mind",
        this.paused
          ? `🐙 Paused · ${usage}${warning}`
          : `🐙 ${this.active.size} · ${usage}${warning}`,
      );
      if (this.panelVisible)
        ctx.ui.setWidget("shadow-mind-panel", this.statusLines(), {
          placement: "aboveEditor",
        });
    });
  }

  private hasRecentRunErrors(): boolean {
    return this.recentEvents
      .slice(-3)
      .some(
        (event) =>
          event.kind === "run-end" &&
          (event.data?.reason === "error" || event.data?.reason === "timeout"),
      );
  }

  private statusLines(): string[] {
    const config = this.configStore.current;
    const diagnostics = this.usageStore.error
      ? [...this.diagnostics, `usage: ${this.usageStore.error}`]
      : this.diagnostics;
    return [
      `🐙 Shadow Mind · ${this.paused ? "paused" : "active"} · running ${this.active.size}/${config.maxParallelShadows}`,
      `heartbeat ${formatNumber(config.heartbeatProbability)} · batch ${config.resultBatchWindowMs}ms · timeout ${config.defaultShadowTimeoutSeconds}s · drain ${config.headlessDrainTimeoutSeconds}s · thinking ${config.defaultThinkingLevel}`,
      `definitions: ${this.shadowCount} valid · ${this.diagnostics.length} invalid`,
      formatUsageDetail("session", this.sessionUsage),
      `usage lifetime · ${formatUsageSummary(this.usageStore.current)}`,
      ...this.recentRuns
        .slice(-3)
        .map(
          ({ shadowName, completedAt, result }) =>
            `recent run · ${formatCompletedAt(completedAt)} · ${shadowName} · ${result.reason} · ${formatUsageSummary(result.usage)}`,
        ),
      ...diagnostics.map((diagnostic) => `diagnostic: ${diagnostic}`),
      ...this.recentEvents.slice(-5).map((event) => {
        const failed =
          event.kind === "run-end" &&
          (event.data?.reason === "error" || event.data?.reason === "timeout");
        const detail = failed
          ? ` ${event.data?.error ?? event.data?.reason}`
          : "";
        return `${new Date(event.at).toLocaleTimeString("en-GB", { hour12: false })} ${event.kind}${detail}`;
      }),
      "Shortcut: Alt+S toggle · Commands: /shadow toggle | pause | resume | status | hide",
    ];
  }
}

function resolveModel(ctx: ExtensionContext, fullId: string) {
  const separator = fullId.indexOf("/");
  if (separator <= 0 || separator === fullId.length - 1) return undefined;
  return ctx.modelRegistry.find(
    fullId.slice(0, separator),
    fullId.slice(separator + 1),
  );
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function formatCompletedAt(completedAt: string): string {
  return new Date(completedAt).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}
