import { readFileSync } from "node:fs";

/**
 * ACP (agent context protocol) compression sidecar support.
 *
 * pi's ACP context manager folds old conversation ranges into summaries stored
 * in `<sessionFile>.acp.json`. The session entry log itself is never rewritten
 * and no native `compaction` entries are created, so `buildSessionContext`
 * still reconstructs the full uncompressed history and the serialized shadow
 * trajectory can exceed the model context window (every activation then fails
 * instantly with "trajectory ~N tokens exceeds ... context window").
 *
 * This module projects the entry list the same way the main agent sees it:
 * every message covered by an active ACP block collapses, and the first
 * covered message of each block is replaced by a `compactionSummary` message
 * carrying the block summary.
 */

interface AcpBlock {
	blockId?: unknown;
	tier?: unknown;
	summary?: unknown;
	active?: unknown;
	effectiveMessageIds?: unknown;
}

interface SessionEntryLike {
	id?: unknown;
	type?: unknown;
	message?: unknown;
}

interface SessionMessageLike {
	role?: unknown;
}

/** Stub role whose empty content the trajectory serializer skips entirely. */
const FOLDED_STUB_ROLE = "assistant";

/**
 * Return `entries` with every message covered by an active ACP block folded
 * away. The first covered message of each block becomes a `compactionSummary`
 * message containing the block summary; later covered messages become empty
 * assistant stubs that `serializeTrajectory` skips. Entry ids and parent links
 * are preserved so branch walking in `buildSessionContext` is unaffected.
 *
 * Any failure (missing/invalid sidecar, no active blocks) returns the entries
 * unchanged, so sessions without ACP behave exactly as before.
 */
export function applyAcpCompressionProjection<T extends SessionEntryLike>(
	entries: readonly T[],
	sessionFile: string | undefined,
): T[] {
	if (!sessionFile) return [...entries];
	let sidecar: { blocks?: unknown };
	try {
		sidecar = JSON.parse(readFileSync(`${sessionFile}.acp.json`, "utf8")) as { blocks?: unknown };
	} catch {
		return [...entries];
	}
	const blocks = (Array.isArray(sidecar.blocks) ? sidecar.blocks : [])
		.filter((block): block is AcpBlock => Boolean(block) && typeof block === "object")
		.filter((block) => block.active === true && typeof block.blockId === "string");
	if (!blocks.length) return [...entries];

	const coveredBy = new Map<string, AcpBlock>();
	for (const block of blocks) {
		const ids = Array.isArray(block.effectiveMessageIds) ? block.effectiveMessageIds : [];
		for (const id of ids) {
			if (typeof id === "string" && !coveredBy.has(id)) coveredBy.set(id, block);
		}
	}
	if (!coveredBy.size) return [...entries];

	const emitted = new Set<string>();
	return entries.map((entry) => {
		const block = typeof entry.id === "string" ? coveredBy.get(entry.id) : undefined;
		if (!block) return entry;
		const message = entry.message as SessionMessageLike | undefined;
		if (entry.type !== "message" || !message || typeof message !== "object") return entry;
		const blockId = block.blockId as string;
		if (!emitted.has(blockId)) {
			emitted.add(blockId);
			const summary = typeof block.summary === "string" ? block.summary : "";
			return {
				...entry,
				message: {
					...message,
					role: "compactionSummary",
					content: `[ACP block ${blockId} — ${coverageCount(block)} folded messages]\n${summary}`,
				},
			} as T;
		}
		return { ...entry, message: { ...message, role: FOLDED_STUB_ROLE, content: [] } } as T;
	});
}

function coverageCount(block: AcpBlock): number {
	return Array.isArray(block.effectiveMessageIds) ? block.effectiveMessageIds.length : 0;
}
