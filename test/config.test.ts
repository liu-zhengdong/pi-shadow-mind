import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfig, serializeConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("uses built-in defaults", () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.defaultShadowTimeoutSeconds).toBe(300);
    expect(DEFAULT_CONFIG.heartbeatTools).toEqual([]);
  });

  it("parses and deduplicates heartbeat_tools", () => {
    const config = parseConfig({ heartbeat_tools: ["bash", "edit", "bash"] });
    expect(config.heartbeatTools).toEqual(["bash", "edit"]);
  });

  it("rejects invalid heartbeat_tools", () => {
    expect(() => parseConfig({ heartbeat_tools: "not-an-array" })).toThrow(
      /heartbeat_tools/,
    );
    expect(() => parseConfig({ heartbeat_tools: [""] })).toThrow(
      /heartbeat_tools/,
    );
  });

  it("serializes heartbeat_tools only when non-empty", () => {
    const withTools = serializeConfig({
      ...DEFAULT_CONFIG,
      heartbeatTools: ["bash", "write"],
    });
    expect(withTools).toContain('"heartbeat_tools": [\n    "bash",\n    "write"\n  ]');

    const defaultEmpty = serializeConfig(DEFAULT_CONFIG);
    expect(defaultEmpty).not.toContain("heartbeat_tools");
  });

  it("excludes session-recording extensions by default", () => {
    expect(DEFAULT_CONFIG.excludedExtensions).toEqual(["pi-experiencev2"]);
    expect(parseConfig({}).excludedExtensions).toEqual(["pi-experiencev2"]);
  });

  it("lets an empty excluded_extensions survive a write/read round trip", () => {
    const cleared = { ...DEFAULT_CONFIG, excludedExtensions: [] };
    const serialized = serializeConfig(cleared);
    expect(serialized).toContain('"excluded_extensions": []');
    expect(parseConfig(JSON.parse(serialized)).excludedExtensions).toEqual([]);
  });

  it("rejects invalid excluded_extensions", () => {
    expect(parseConfig({ excluded_extensions: ["a", "a", "b"] }).excludedExtensions).toEqual([
      "a",
      "b",
    ]);
    expect(() => parseConfig({ excluded_extensions: "pi-experiencev2" })).toThrow(
      /excluded_extensions/,
    );
    expect(() => parseConfig({ excluded_extensions: [""] })).toThrow(/excluded_extensions/);
  });

  it("rejects invalid probability", () => {
    expect(() => parseConfig({ heartbeat_probability: 2 })).toThrow(
      /heartbeat_probability/,
    );
  });

  it("accepts a deterministic benchmark seed", () => {
    expect(parseConfig({ random_seed: 42 }).randomSeed).toBe(42);
    expect(() => parseConfig({ random_seed: -1 })).toThrow(/random_seed/);
    expect(() => parseConfig({ random_seed: 1.5 })).toThrow(/random_seed/);
  });
});
