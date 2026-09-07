import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const DEFAULT_READ_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface ShadowConfig {
  heartbeatProbability: number;
  heartbeatTools: string[];
  maxParallelShadows: number;
  defaultShadowTimeoutSeconds: number;
  headlessDrainTimeoutSeconds: number;
  resultBatchWindowMs: number;
  defaultShadowModel?: string;
  defaultThinkingLevel: ThinkingLevel;
  randomSeed?: number;
}

export const SHADOW_TRIGGERS = ["heartbeat", "final_response"] as const;
export type ShadowTrigger = (typeof SHADOW_TRIGGERS)[number];

export interface ShadowDefinition {
  id: string;
  name: string;
  enabled: boolean;
  debug: boolean;
  activationProbability: number;
  trigger: ShadowTrigger[];
  activeForModels: string[];
  runWithModel?: string;
  thinkingLevel?: ThinkingLevel;
  timeoutSeconds?: number;
  tools: string[];
  activationTools: string[];
  prompt: string;
  filePath: string;
}

export interface RegistryDiagnostic {
  filePath: string;
  message: string;
}

export interface RegistrySnapshot {
  shadows: ShadowDefinition[];
  diagnostics: RegistryDiagnostic[];
}

export type RunEndReason =
  | "report"
  | "silent"
  | "timeout"
  | "aborted"
  | "error";

export interface ShadowReport {
  shadowId: string;
  shadowName: string;
  content: string;
  epoch: number;
  runId: string;
}

export interface RuntimeEvent {
  at: string;
  kind: string;
  epoch: number;
  data?: Record<string, unknown>;
}

export interface ShadowActivationDecision {
  activated: Array<{ shadow: ShadowDefinition; roll: number }>;
  candidates: Array<{ shadowId: string; roll: number; selected: boolean }>;
  /** Shadow ids excluded because active_for_models did not match the main model. */
  modelFiltered: string[];
  /** Shadow ids excluded because the same shadow is already running. */
  runningExcluded: string[];
}

export interface HeartbeatDecision extends ShadowActivationDecision {
  heartbeatRoll: number;
  toolFiltered: string[];
}
