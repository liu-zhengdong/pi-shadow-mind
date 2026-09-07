import { describe, expect, it } from "vitest";
import { ReportHistory } from "../src/report-history.js";
import type { ShadowReport } from "../src/types.js";

const report = (runId: string, content = runId): ShadowReport => ({
  shadowId: `shadow-${runId}`, shadowName: `Shadow ${runId}`, content, epoch: 1, runId,
});

describe("ReportHistory", () => {
  it("retains the newest delivered reports in newest-first order", () => {
    const history = new ReportHistory(2);
    history.add([report("one"), report("two"), report("three")], "2026-09-07T00:00:00Z");
    expect(history.list().map(({ runId }) => runId)).toEqual(["three", "two"]);
    expect(history.list()[0].deliveredAt).toBe("2026-09-07T00:00:00Z");
  });

  it("replaces duplicate run IDs and moves them to the newest position", () => {
    const history = new ReportHistory(2);
    history.add([report("one", "old"), report("two")]);
    history.add([report("one", "new")]);
    expect(history.list().map(({ content }) => content)).toEqual(["new", "two"]);
  });

  it("isolates stored reports from producers and snapshot consumers", () => {
    const history = new ReportHistory();
    const original = report("one");
    history.add([original]);
    original.content = "producer mutation";
    history.list()[0].content = "viewer mutation";
    expect(history.list()[0].content).toBe("one");
    history.clear();
    expect(history.list()).toEqual([]);
  });

  it("supports zero retention and validates capacity", () => {
    const history = new ReportHistory(0);
    history.add([report("one")]);
    expect(history.list()).toEqual([]);
    expect(() => new ReportHistory(-1)).toThrow();
    expect(() => new ReportHistory(NaN)).toThrow();
  });
});
