import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import YAML from "yaml";
import {
  SHADOW_TRIGGERS,
  type RegistryDiagnostic,
  type RegistrySnapshot,
  type ShadowDefinition,
  type ShadowTrigger,
} from "./types.js";
import {
  cleanStringArray,
  inRange,
  isFiniteNumber,
  isNonEmptyString,
  isStringArray,
  isThinkingLevel,
} from "./validation.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export class ShadowRegistry {
  readonly directory: string;
  private readonly cache = new Map<
    string,
    { mtimeMs: number; shadow?: ShadowDefinition; error?: string }
  >();

  constructor(agentDir: string) {
    this.directory = join(agentDir, "shadow-minds");
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  async load(): Promise<RegistrySnapshot> {
    await this.initialize();
    const names = (await readdir(this.directory))
      .filter((name) => extname(name).toLowerCase() === ".md")
      .sort();
    const shadows: ShadowDefinition[] = [];
    const diagnostics: RegistryDiagnostic[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const filePath = join(this.directory, name);
      seen.add(filePath);
      const fileStat = await stat(filePath);
      const cached = this.cache.get(filePath);
      if (cached && cached.mtimeMs === fileStat.mtimeMs) {
        // Unchanged since last load: reuse the cached parse result.
        if (cached.shadow) shadows.push(cached.shadow);
        if (cached.error) diagnostics.push({ filePath, message: cached.error });
        continue;
      }
      try {
        const definition = parseShadowMarkdown(
          await readFile(filePath, "utf8"),
          filePath,
        );
        this.cache.set(filePath, {
          mtimeMs: fileStat.mtimeMs,
          shadow: definition,
        });
        shadows.push(definition);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.cache.set(filePath, { mtimeMs: fileStat.mtimeMs, error: message });
        diagnostics.push({ filePath, message });
      }
    }
    for (const filePath of [...this.cache.keys()]) {
      if (!seen.has(filePath)) this.cache.delete(filePath);
    }
    // Detect duplicate ids across (possibly cached) definitions; first file wins.
    const unique: ShadowDefinition[] = [];
    const ids = new Set<string>();
    for (const shadow of shadows) {
      if (ids.has(shadow.id)) {
        diagnostics.push({
          filePath: shadow.filePath,
          message: `duplicate shadow id: ${shadow.id}`,
        });
      } else {
        ids.add(shadow.id);
        unique.push(shadow);
      }
    }
    return { shadows: unique, diagnostics };
  }
}

export function parseShadowMarkdown(
  source: string,
  filePath: string,
): ShadowDefinition {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/.exec(
    source,
  );
  if (!match) throw new Error("missing YAML frontmatter");
  const meta = YAML.parse(match[1]) as unknown;
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    throw new Error("frontmatter must be an object");
  const value = meta as Record<string, unknown>;
  const fallbackId = basename(filePath, extname(filePath));
  const id = stringValue(value.id, fallbackId, "id");
  if (!ID_PATTERN.test(id))
    throw new Error("id must match [a-z0-9][a-z0-9_-]*");
  const prompt = match[2].trim();
  if (!prompt) throw new Error("shadow prompt body is empty");
  return {
    id,
    name: stringValue(value.name, id, "name"),
    enabled: booleanValue(value.enabled, true, "enabled"),
    debug: booleanValue(value.debug, false, "debug"),
    activationProbability: probabilityValue(
      value.activation_probability,
      0.3,
      "activation_probability",
    ),
    trigger: triggerArray(value.trigger, ["heartbeat"], "trigger"),
    activeForModels: cleanStringArray(
      value.active_for_models,
      ["*"],
      "active_for_models",
    ),
    runWithModel: optionalString(value.run_with_model, "run_with_model"),
    thinkingLevel: optionalThinking(value.thinking_level),
    timeoutSeconds: optionalPositiveNumber(
      value.timeout_seconds,
      "timeout_seconds",
    ),
    activationTools: cleanStringArray(
      value.activation_tools,
      [],
      "activation_tools",
    ),
    tools: cleanStringArray(value.tools, [], "tools"),
    prompt,
    filePath,
  };
}

function stringValue(value: unknown, fallback: string, name: string): string {
  if (value === undefined) return fallback;
  if (!isNonEmptyString(value))
    throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, "", name);
}
function booleanValue(
  value: unknown,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}
function probabilityValue(
  value: unknown,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!isFiniteNumber(value) || !inRange(value, 0, 1))
    throw new Error(`${name} must be between 0 and 1`);
  return value;
}
function optionalPositiveNumber(
  value: unknown,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!isFiniteNumber(value) || value <= 0)
    throw new Error(`${name} must be positive`);
  return value;
}
function triggerArray(
  value: unknown,
  fallback: ShadowTrigger[],
  name: string,
): ShadowTrigger[] {
  const values = typeof value === "string" ? [value] : value;
  const items = cleanStringArray(values, fallback, name);
  const allowed = new Set<string>(SHADOW_TRIGGERS);
  const invalid = items.filter((item) => !allowed.has(item));
  if (invalid.length)
    throw new Error(`${name} contains invalid trigger: ${invalid.join(", ")}`);
  return items as ShadowTrigger[];
}
function optionalThinking(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (!isThinkingLevel(value)) throw new Error("thinking_level is invalid");
  return value;
}
