import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ShadowConfig } from "./types.js";
import { cleanStringArray, inRange, isFiniteNumber, isNonEmptyString, isThinkingLevel } from "./validation.js";

export const DEFAULT_CONFIG: ShadowConfig = {
  heartbeatProbability: 1 / 3,
  heartbeatTools: [],
  maxParallelShadows: 2,
  defaultShadowTimeoutSeconds: 300,
  headlessDrainTimeoutSeconds: 120,
  resultBatchWindowMs: 400,
  defaultThinkingLevel: "low",
};

export function parseConfig(input: unknown): ShadowConfig {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("config must be a JSON object");
  }
  const value = input as Record<string, unknown>;
  const probability = numberInRange(value.heartbeat_probability, 0, 1, DEFAULT_CONFIG.heartbeatProbability, "heartbeat_probability");
  const heartbeatTools = cleanStringArray(value.heartbeat_tools, DEFAULT_CONFIG.heartbeatTools, "heartbeat_tools");
  const parallel = positiveInteger(value.max_parallel_shadows, DEFAULT_CONFIG.maxParallelShadows, "max_parallel_shadows");
  const timeout = positiveNumber(value.default_shadow_timeout_seconds, DEFAULT_CONFIG.defaultShadowTimeoutSeconds, "default_shadow_timeout_seconds");
  const drainTimeout = positiveNumber(value.headless_drain_timeout_seconds, DEFAULT_CONFIG.headlessDrainTimeoutSeconds, "headless_drain_timeout_seconds");
  const windowMs = nonNegativeInteger(value.result_batch_window_ms, DEFAULT_CONFIG.resultBatchWindowMs, "result_batch_window_ms");
  const model = optionalNonEmptyString(value.default_shadow_model, "default_shadow_model");
  const randomSeed = optionalSeed(value.random_seed);
  const thinking = value.default_thinking_level ?? DEFAULT_CONFIG.defaultThinkingLevel;
  if (!isThinkingLevel(thinking)) {
    throw new Error("default_thinking_level is invalid");
  }
  return {
    heartbeatProbability: probability,
    heartbeatTools,
    maxParallelShadows: parallel,
    defaultShadowTimeoutSeconds: timeout,
    headlessDrainTimeoutSeconds: drainTimeout,
    resultBatchWindowMs: windowMs,
    defaultShadowModel: model,
    defaultThinkingLevel: thinking as ThinkingLevel,
    randomSeed,
  };
}

export function serializeConfig(config: ShadowConfig): string {
  return `${JSON.stringify({
    heartbeat_probability: config.heartbeatProbability,
    ...(config.heartbeatTools && config.heartbeatTools.length ? { heartbeat_tools: config.heartbeatTools } : {}),
    max_parallel_shadows: config.maxParallelShadows,
    default_shadow_timeout_seconds: config.defaultShadowTimeoutSeconds,
    headless_drain_timeout_seconds: config.headlessDrainTimeoutSeconds,
    result_batch_window_ms: config.resultBatchWindowMs,
    ...(config.defaultShadowModel ? { default_shadow_model: config.defaultShadowModel } : {}),
    default_thinking_level: config.defaultThinkingLevel,
    ...(config.randomSeed !== undefined ? { random_seed: config.randomSeed } : {}),
  }, null, 2)}\n`;
}

export class ConfigStore {
  readonly configPath: string;
  private lastGood = DEFAULT_CONFIG;
  private lastError?: string;

  constructor(private readonly agentDir: string) {
    this.configPath = join(agentDir, "shadow-minds", "config.json");
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    try {
      await readFile(this.configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(this.configPath, serializeConfig(DEFAULT_CONFIG), "utf8");
    }
    await this.reload();
  }

  async reload(): Promise<{ config: ShadowConfig; error?: string }> {
    try {
      const raw = await readFile(this.configPath, "utf8");
      this.lastGood = parseConfig(JSON.parse(raw));
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    return { config: this.lastGood, error: this.lastError };
  }

  get current(): ShadowConfig {
    return this.lastGood;
  }

  get error(): string | undefined {
    return this.lastError;
  }
}

function numberInRange(value: unknown, min: number, max: number, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!isFiniteNumber(value) || !inRange(value, min, max)) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

function positiveNumber(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!isFiniteNumber(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  const parsed = positiveNumber(value, fallback, name);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function nonNegativeInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function optionalNonEmptyString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isNonEmptyString(value)) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalSeed(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("random_seed must be an integer between 0 and 4294967295");
  }
  return value;
}
