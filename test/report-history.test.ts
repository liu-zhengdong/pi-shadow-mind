import { describe, expect, it } from "vitest";
import { ReportHistory } from "../src/report-history.js";
import type { ShadowReport } from "../src/types.js";

const report = (runId: string, content = runId): ShadowReport => ({
  shadowId: `shadow-${runId}`,
  shadowName: `Shadow ${runId}`,
  content,
  epoch: 1,
  runId,
});

describe("ReportHistory", () => {
  it("keeps the newest reports up to the shared status-panel limit", () => {
    let limit = 2;
    const history = new ReportHistory(() => limit);

    history.add([report("one"), report("two"), report("three")]);

    expect(history.forRun("one")).toBeUndefined();
    expect(history.forRun("two")?.content).toBe("two");
    expect(history.forRun("three")?.content).toBe("three");

    limit = 1;
    history.add([report("four")]);
    expect(history.forRun("two")).toBeUndefined();
    expect(history.forRun("three")).toBeUndefined();
    expect(history.forRun("four")?.content).toBe("four");
  });

  it("replaces a report for the same run", () => {
    const history = new ReportHistory(() => 2);
    history.add([report("one", "old")]);
    history.add([report("one", "new")]);

    expect(history.forRun("one")?.content).toBe("new");
  });
});
