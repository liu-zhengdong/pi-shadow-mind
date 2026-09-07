import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSessionContext, type SessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildShadowSessionContext } from "../src/acp-projection.js";
import { serializeTrajectory } from "../src/trajectory.js";

type Message = SessionContext["messages"][number];
const dirs: string[] = [];
const timestamp = "2026-01-01T00:00:00.000Z";
function sidecar(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-projection-"));
  dirs.push(dir);
  const file = join(dir, "session.jsonl");
  writeFileSync(`${file}.acp.json`, JSON.stringify(value));
  return file;
}
function block(ids: string[], summary = "compressed facts", blockId = "b1") {
  return { blockId, active: true, summary, effectiveMessageIds: ids };
}
function entry(id: string, message: Message): SessionEntry {
  return { type: "message", id, parentId: null, timestamp, message };
}
function user(id: string, text = id): SessionEntry {
  return entry(id, { role: "user", content: text, timestamp: 0 });
}
function assistant(id: string, callIds: string[] = []): SessionEntry {
  return entry(id, {
    role: "assistant", content: [
      { type: "text", text: `text-${id}` },
      ...callIds.map((callId) => ({ type: "toolCall" as const, id: callId, name: "bash", arguments: { command: `COMMAND_${callId}` } })),
    ], api: "openai-completions", provider: "openai", model: "test", stopReason: "stop", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
}
function result(id: string, callId: string): SessionEntry {
  return entry(id, { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0 });
}
function report(id: string): SessionEntry {
  return { type: "custom_message", id, parentId: null, timestamp, customType: "shadow-report", content: `report-${id}`, display: true };
}
function chain(entries: SessionEntry[]): SessionEntry[] {
  return entries.map((item, index) => ({ ...item, parentId: entries[index - 1]?.id ?? null }));
}
function project(entries: SessionEntry[], file?: string, leafId = entries.at(-1)?.id) {
  return buildShadowSessionContext(entries, leafId, file);
}
function trajectory(entries: SessionEntry[], blocks: unknown[]) {
  const messages = project(chain(entries), sidecar({ blocks })).messages;
  return serializeTrajectory(messages as unknown as Parameters<typeof serializeTrajectory>[0]);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("buildShadowSessionContext", () => {
  it("preserves the native context without a sidecar", () => {
    const entries = chain([user("u"), assistant("a")]);
    expect(project(entries)).toEqual(buildSessionContext(entries));
    expect(project(entries, join(tmpdir(), "missing-acp-review.jsonl"))).toEqual(buildSessionContext(entries));
  });

  it.each([null, [], 1, "invalid", {}, { blocks: null }, { blocks: [null] },
    { blocks: [{ ...block(["a"]), summary: null }] },
    { blocks: [{ ...block(["a"]), summary: " " }] },
    { blocks: [{ ...block(["a"]), effectiveMessageIds: [1] }] },
    { blocks: [block(["a"]), block(["u"])] },
  ])("falls back for invalid sidecar shape %j", (value) => {
    const entries = chain([user("u"), assistant("a")]);
    expect(project(entries, sidecar(value))).toEqual(buildSessionContext(entries));
  });

  it("falls back for malformed JSON", () => {
    const file = sidecar({});
    writeFileSync(`${file}.acp.json`, "not json{");
    const entries = chain([user("u"), assistant("a")]);
    expect(project(entries, file)).toEqual(buildSessionContext(entries));
  });

  it("folds a range once, retains the tail, and leaves session entries untouched", () => {
    const entries = chain([user("root"), user("old"), assistant("a"), user("tail")]);
    const before = structuredClone(entries);
    const text = trajectory(entries, [block(["old", "a"])]);
    expect(text).toContain("SUMMARY: [ACP block b1 — 2 folded messages]\ncompressed facts");
    expect(text.match(/SUMMARY:/g)).toHaveLength(1);
    expect(text).toContain("USER: tail");
    expect(text).not.toContain("USER: old");
    expect(text).not.toContain("text-a");
    expect(entries).toEqual(before);
  });

  it("preserves ACP's first user message even when covered", () => {
    const text = trajectory([user("root"), assistant("a"), user("tail")], [block(["root", "a"])]);
    expect(text).toContain("USER: root");
    expect(text).not.toContain("text-a");
  });

  it("ignores inactive blocks and supports decompression on the next activation", () => {
    const entries = chain([user("root"), assistant("a"), user("tail")]);
    const file = sidecar({ blocks: [block(["a"])] });
    expect(project(entries, file).messages.some((message) => message.role === "compactionSummary")).toBe(true);
    writeFileSync(`${file}.acp.json`, JSON.stringify({ blocks: [{ ...block(["a"]), active: false }] }));
    expect(project(entries, file)).toEqual(buildSessionContext(entries));
  });

  it("folds fully covered multi-call messages and their accompanying text", () => {
    const text = trajectory([user("root"), assistant("a", ["c1", "c2"]), result("r1", "c1"), result("r2", "c2"), user("tail")],
      [block(["a#c1", "a#c2", "r1", "r2"])]);
    expect(text).toContain("compressed facts");
    expect(text).not.toContain("COMMAND_");
    expect(text).not.toContain("text-a");
  });

  it("preserves uncovered calls and original text in a partially folded batch", () => {
    const text = trajectory([user("root"), assistant("a", ["c1", "c2"]), result("r1", "c1"), result("r2", "c2")],
      [block(["a#c1", "r1"])]);
    expect(text).not.toContain("COMMAND_c1");
    expect(text).toContain("COMMAND_c2");
    expect(text).toContain("text-a");
  });

  it("retains separate summaries anchored to the same multi-call entry", () => {
    const text = trajectory([user("root"), assistant("a", ["c1", "c2"]), result("r1", "c1"), result("r2", "c2")],
      [block(["a#c1", "r1"], "first summary", "b1"), block(["a#c2", "r2"], "second summary", "b2")]);
    expect(text).toContain("first summary");
    expect(text).toContain("second summary");
    expect(text.match(/SUMMARY:/g)).toHaveLength(2);
    expect(text).not.toContain("COMMAND_");
  });

  it("folds a single tool call by its entry ID", () => {
    const text = trajectory([user("root"), assistant("a", ["c1"]), result("r1", "c1")], [block(["a", "r1"])]);
    expect(text).toContain("compressed facts");
    expect(text).not.toContain("COMMAND_c1");
  });

  it("folds covered custom shadow reports", () => {
    const text = trajectory([user("root"), report("s"), user("tail")], [block(["s"])]);
    expect(text).toContain("compressed facts");
    expect(text).not.toContain("report-s");
  });

  it("strips orphaned calls/results across compression boundaries", () => {
    const entries = [user("root"), assistant("a", ["c1", "c2"]), result("r1", "c1"), result("r2", "c2")];
    const text = trajectory(entries, [block(["a#c1", "r2"])]);
    expect(text).not.toContain("COMMAND_");
    expect(text).not.toContain("TOOL RESULT:");
  });

  it("does not let an inactive branch consume the summary anchor", () => {
    const entries = chain([user("root"), assistant("left")]);
    entries.push({ ...assistant("right"), parentId: "root" });
    const text = serializeTrajectory(project(entries, sidecar({ blocks: [block(["left", "right"])] }), "right").messages as unknown as Parameters<typeof serializeTrajectory>[0]);
    expect(text).toContain("compressed facts");
    expect(text).not.toContain("text-left");
    expect(text).not.toContain("text-right");
  });

  it("ignores blocks covering only another branch", () => {
    const entries = chain([user("root"), assistant("left")]);
    entries.push({ ...assistant("right"), parentId: "root" });
    expect(project(entries, sidecar({ blocks: [block(["left"])] }), "right")).toEqual(buildSessionContext(entries, "right"));
  });

  it("applies native compaction before ACP and retains the native summary", () => {
    const compact: SessionEntry = { type: "compaction", id: "compact", parentId: null, timestamp, summary: "native facts", firstKeptEntryId: "kept", tokensBefore: 100 };
    const entries = chain([user("root"), assistant("old"), user("kept"), assistant("a"), compact, user("tail")]);
    const text = trajectory(entries, [block(["old", "a"])]);
    expect(text).toContain("SUMMARY: native facts");
    expect(text).toContain("compressed facts");
    expect(text).not.toContain("text-old");
    expect(text).not.toContain("text-a");
    expect(text).toContain("USER: kept");
  });

  it("keeps only active nested summaries", () => {
    const text = trajectory([user("root"), assistant("a"), assistant("b")], [
      { ...block(["a"], "obsolete", "b1"), active: false },
      block(["a", "b"], "merged summary", "b2"),
    ]);
    expect(text).toContain("merged summary");
    expect(text).not.toContain("obsolete");
    expect(text.match(/SUMMARY:/g)).toHaveLength(1);
  });
});
