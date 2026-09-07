import { readFileSync } from "node:fs";

export interface AcpBlock {
  blockId: string;
  summary: string;
  effectiveMessageIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read Active Context Pruning's persisted blocks; invalid state never hides history. */
export function readAcpBlocks(sessionFile: string | undefined): AcpBlock[] {
  if (!sessionFile) return [];
  try {
    const state: unknown = JSON.parse(readFileSync(`${sessionFile}.acp.json`, "utf8"));
    if (!isRecord(state) || !Array.isArray(state.blocks)) return [];
    const blocks: AcpBlock[] = [];
    const seen = new Set<string>();
    for (const block of state.blocks) {
      if (!isRecord(block)) return [];
      if (block.active === false) continue;
      if (block.active !== true || typeof block.blockId !== "string" || !block.blockId ||
          typeof block.summary !== "string" || !block.summary.trim() ||
          !Array.isArray(block.effectiveMessageIds) ||
          !block.effectiveMessageIds.every((id: unknown) => typeof id === "string" && id.length > 0) ||
          seen.has(block.blockId)) return [];
      seen.add(block.blockId);
      blocks.push({
        blockId: block.blockId,
        summary: block.summary,
        effectiveMessageIds: [...block.effectiveMessageIds],
      });
    }
    return blocks;
  } catch {
    return [];
  }
}
