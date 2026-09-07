import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Canonical set of valid pi thinking levels, shared by config and registry. */
export const THINKING_LEVELS: ReadonlySet<ThinkingLevel> = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

export function cleanStringArray(
  value: unknown,
  fallback: string[],
  name: string,
): string[] {
  if (value === undefined) return [...fallback];
  if (!isStringArray(value))
    throw new Error(`${name} must be an array of non-empty strings`);
  return [...new Set(value.map((item) => item.trim()))];
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel);
}
