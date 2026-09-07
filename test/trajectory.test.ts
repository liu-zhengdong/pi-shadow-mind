import { describe, expect, it } from "vitest";
import { sanitizeTrajectory, serializeTrajectory } from "../src/trajectory.js";

describe("sanitizeTrajectory", () => {
  it("removes thinking and summarizes tool results while retaining calls", () => {
    const result = sanitizeTrajectory([
      { role: "assistant", content: [
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "I will inspect it." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
      ] },
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "one\ntwo" }], details: { huge: true }, isError: false },
      { role: "custom", customType: "other-plugin", content: "hidden" },
      { role: "custom", customType: "shadow-report", content: "previous feedback" },
    ]);
    expect((result[0].content as Array<{ type: string }>).map(({ type }) => type)).toEqual(["text", "toolCall"]);
    expect(result[1].content).toEqual([{ type: "text", text: "2 read · one" }]);
    expect(result[1].details).toBeUndefined();
    expect(result).toHaveLength(3);
  });
});

describe("serializeTrajectory", () => {
  it("retains native compaction and branch summary payloads", () => {
    const result = serializeTrajectory([
      { role: "compactionSummary", summary: "compacted facts", tokensBefore: 100, timestamp: 0 },
      { role: "branchSummary", summary: "branch facts", fromId: "old", timestamp: 0 },
      { role: "compactionSummary", content: "legacy content" },
    ]);
    expect(result).toContain("SUMMARY: compacted facts");
    expect(result).toContain("SUMMARY: branch facts");
    expect(result).toContain("SUMMARY: legacy content");
  });

  it("renders a plain-text transcript and joins tool summaries to their calls", () => {
    const result = serializeTrajectory([
      { role: "user", content: [{ type: "text", text: "Inspect it." }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "Reading now." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
      ] },
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "one\ntwo" }], isError: false },
      { role: "custom", customType: "shadow-report", content: "previous feedback" },
    ]);
    expect(result).toContain("USER: Inspect it.");
    expect(result).toContain("MAIN: Reading now.");
    expect(result).toContain('TOOL: read({"path":"a.ts"}) · 2 read · one');
    expect(result).toContain("SHADOW FEEDBACK: previous feedback");
    expect(result).not.toContain("secret");
  });
});
