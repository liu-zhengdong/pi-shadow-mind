import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyAcpCompressionProjection } from "../src/acp-projection.js";
import { serializeTrajectory } from "../src/trajectory.js";

const tempDirs: string[] = [];

function writeSidecar(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "acp-projection-"));
	tempDirs.push(dir);
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(`${sessionFile}.acp.json`, contents, "utf8");
	return sessionFile;
}

function messageEntry(id: string, role: string, text: string) {
	return {
		type: "message",
		id,
		parentId: undefined,
		message: { role, content: text as unknown, timestamp: 1 },
	};
}

afterEach(() => {
	while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("applyAcpCompressionProjection", () => {
	it("returns entries unchanged when no session file is available", () => {
		const entries = [messageEntry("m1", "user", "hello")];
		const result = applyAcpCompressionProjection(entries, undefined);
		expect(result).toEqual(entries);
		expect(result).not.toBe(entries);
	});

	it("returns entries unchanged when the sidecar does not exist", () => {
		const entries = [messageEntry("m1", "user", "hello")];
		const result = applyAcpCompressionProjection(entries, join(tmpdir(), "does-not-exist.jsonl"));
		expect(result).toEqual(entries);
	});

	it("returns entries unchanged when the sidecar is malformed", () => {
		const sessionFile = writeSidecar("not json{");
		const entries = [messageEntry("m1", "user", "hello")];
		expect(applyAcpCompressionProjection(entries, sessionFile)).toEqual(entries);
	});

	it("folds covered messages and anchors the block summary at the first covered entry", () => {
		const sessionFile = writeSidecar(
			JSON.stringify({
				blocks: [
					{
						blockId: "b7",
						tier: 1,
						active: true,
						summary: "compressed facts",
						effectiveMessageIds: ["m2", "m3", "m4"],
					},
				],
			}),
		);
		const entries = [
			messageEntry("m1", "user", "first"),
			messageEntry("m2", "user", "old question"),
			messageEntry("m3", "assistant", "old answer"),
			messageEntry("m4", "user", "older question"),
			messageEntry("m5", "assistant", "fresh answer"),
		];
		const result = applyAcpCompressionProjection(entries, sessionFile);

		expect(result[0]).toBe(entries[0]);
		expect(result[4]).toBe(entries[4]);

		const anchor = result[1].message as { role: string; content: string };
		expect(anchor.role).toBe("compactionSummary");
		expect(anchor.content).toContain("b7");
		expect(anchor.content).toContain("compressed facts");

		for (const folded of [result[2], result[3]]) {
			const message = folded.message as { role: string; content: unknown };
			expect(message.role).toBe("assistant");
			expect(message.content).toEqual([]);
		}

		expect(result.map((entry) => entry.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
	});

	it("ignores inactive blocks", () => {
		const sessionFile = writeSidecar(
			JSON.stringify({
				blocks: [
					{ blockId: "b1", active: false, summary: "old", effectiveMessageIds: ["m1"] },
				],
			}),
		);
		const entries = [messageEntry("m1", "user", "still visible")];
		expect(applyAcpCompressionProjection(entries, sessionFile)).toEqual(entries);
	});

	it("produces a compact serialized trajectory with a single SUMMARY line per block", () => {
		const sessionFile = writeSidecar(
			JSON.stringify({
				blocks: [
					{
						blockId: "b3",
						active: true,
						summary: "everything before",
						effectiveMessageIds: ["m1", "m2"],
					},
				],
			}),
		);
		const entries = [
			messageEntry("m1", "user", "forgotten question"),
			messageEntry("m2", "assistant", "forgotten answer"),
			messageEntry("m3", "user", "current question"),
		];
		const projected = applyAcpCompressionProjection(entries, sessionFile);
		const trajectory = serializeTrajectory(projected.map((entry) => entry.message));

		expect(trajectory).toContain("SUMMARY: [ACP block b3 — 2 folded messages]");
		expect(trajectory).toContain("everything before");
		expect(trajectory).toContain("USER: current question");
		expect(trajectory).not.toContain("forgotten question");
		expect(trajectory).not.toContain("forgotten answer");
	});
});
