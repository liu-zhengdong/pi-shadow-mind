import type {
  HeartbeatDecision,
  ShadowActivationDecision,
  ShadowDefinition,
  ShadowTrigger,
} from "./types.js";

export function extractToolNames(toolResults: readonly unknown[]): Set<string> {
  const names = new Set<string>();
  for (const item of toolResults) {
    if (!item || typeof item !== "object") continue;
    const name = (item as { toolName?: unknown }).toolName;
    if (typeof name === "string" && name.trim().length > 0) {
      names.add(name.trim());
    }
  }
  return names;
}

/**
 * Pure conversation turns do not create useful new evidence for repository-oriented
 * Shadows. Requiring at least one completed Main tool call also prevents a silent
 * Shadow report response from recursively scheduling more Shadows.
 */
export function shouldEvaluateHeartbeat(
  toolsOrResults: readonly unknown[] | ReadonlySet<string>,
  heartbeatTools?: readonly string[],
): boolean {
  const toolNames =
    toolsOrResults instanceof Set
      ? toolsOrResults
      : extractToolNames(toolsOrResults as readonly unknown[]);
  if (toolNames.size === 0) return false;
  if (!heartbeatTools || heartbeatTools.length === 0) return true;
  return heartbeatTools.some((tool) => toolNames.has(tool));
}

export function shouldEvaluateFinalResponse(
  messages: readonly unknown[],
): boolean {
  const message = messages.at(-1);
  if (
    !message ||
    typeof message !== "object" ||
    (message as { role?: unknown }).role !== "assistant"
  )
    return false;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim().length > 0;
  return (
    Array.isArray(content) &&
    content.some((block) => {
      if (!block || typeof block !== "object") return false;
      const value = block as { type?: unknown; text?: unknown };
      return (
        value.type === "text" &&
        typeof value.text === "string" &&
        value.text.trim().length > 0
      );
    })
  );
}

export function decideHeartbeat(options: {
  heartbeatProbability: number;
  availableSlots: number;
  shadows: readonly ShadowDefinition[];
  activeShadowIds: ReadonlySet<string>;
  mainModelId: string;
  random?: () => number;
  executedTools?: ReadonlySet<string> | readonly string[];
}): HeartbeatDecision {
  const random = options.random ?? Math.random;
  const heartbeatRoll = random();
  if (
    heartbeatRoll >= options.heartbeatProbability ||
    options.availableSlots <= 0
  ) {
    return {
      heartbeatRoll,
      activated: [],
      candidates: [],
      modelFiltered: [],
      runningExcluded: [],
      toolFiltered: [],
    };
  }

  const modelFiltered: string[] = [];
  const runningExcluded: string[] = [];
  const toolFiltered: string[] = [];
  const rolls = options.shadows
    .filter((shadow) => {
      if (!shadow.enabled || !hasTrigger(shadow, "heartbeat")) return false;
      if (options.activeShadowIds.has(shadow.id)) {
        runningExcluded.push(shadow.id);
        return false;
      }
      if (!matchesModel(shadow, options.mainModelId)) {
        modelFiltered.push(shadow.id);
        return false;
      }
      if (!matchesActivationTools(shadow, options.executedTools)) {
        toolFiltered.push(shadow.id);
        return false;
      }
      return true;
    })
    .map((shadow) => ({ shadow, roll: random() }));
  const hits = rolls.filter(
    ({ shadow, roll }) => roll < shadow.activationProbability,
  );

  const selected = sample(
    hits,
    Math.min(options.availableSlots, hits.length),
    random,
  );
  const selectedIds = new Set(selected.map(({ shadow }) => shadow.id));
  return {
    heartbeatRoll,
    activated: selected,
    candidates: rolls.map(({ shadow, roll }) => ({
      shadowId: shadow.id,
      roll,
      selected: selectedIds.has(shadow.id),
    })),
    modelFiltered,
    runningExcluded,
    toolFiltered,
  };
}

export function decideFinalResponse(options: {
  shadows: readonly ShadowDefinition[];
  mainModelId: string;
}): ShadowActivationDecision {
  const modelFiltered: string[] = [];
  const candidates = options.shadows
    .filter((shadow) => {
      if (!shadow.enabled || !hasTrigger(shadow, "final_response"))
        return false;
      if (!matchesModel(shadow, options.mainModelId)) {
        modelFiltered.push(shadow.id);
        return false;
      }
      return true;
    })
    .map((shadow) => ({ shadow, roll: 0 }));
  return {
    activated: candidates,
    candidates: candidates.map(({ shadow, roll }) => ({
      shadowId: shadow.id,
      roll,
      selected: true,
    })),
    modelFiltered,
    runningExcluded: [],
  };
}

export function matchesModel(
  shadow: ShadowDefinition,
  fullModelId: string,
): boolean {
  return (
    shadow.activeForModels.includes("*") ||
    shadow.activeForModels.includes(fullModelId)
  );
}

export function matchesActivationTools(
  shadow: ShadowDefinition,
  executedTools?: ReadonlySet<string> | readonly string[],
): boolean {
  if (shadow.activationTools.length === 0) {
    return true;
  }
  if (!executedTools) return false;
  const executedSet =
    executedTools instanceof Set ? executedTools : new Set(executedTools);
  return shadow.activationTools.some((tool) => executedSet.has(tool));
}

function hasTrigger(shadow: ShadowDefinition, trigger: ShadowTrigger): boolean {
  return shadow.trigger.includes(trigger);
}

function sample<T>(
  values: readonly T[],
  count: number,
  random: () => number,
): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy.slice(0, count);
}
