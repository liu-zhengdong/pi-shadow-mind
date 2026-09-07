import {
  buildContextEntries,
  buildSessionContext,
  sessionEntryToContextMessages,
  type SessionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { readAcpBlocks, type AcpBlock } from "./acp-state.js";

type Message = SessionContext["messages"][number];
type Assistant = Extract<Message, { role: "assistant" }>;
type ToolCall = Extract<Assistant["content"][number], { type: "toolCall" }>;
interface VisibleMessage {
  id: string;
  message: Message;
}

/**
 * Apply persisted Active Context Pruning (billion-context-pi) blocks to the
 * selected Pi context, after native compaction and branch resolution. This
 * adapter projects history only; it does not run ACP tools or context hooks.
 */
export function buildShadowSessionContext(
  entries: SessionEntry[],
  leafId: string | null | undefined,
  sessionFile: string | undefined,
): SessionContext {
  const context = buildSessionContext(entries, leafId);
  const blocks = readAcpBlocks(sessionFile);
  if (!blocks.length) return context;
  const visible = buildContextEntries(entries, leafId).flatMap((entry) =>
    sessionEntryToContextMessages(entry).map((message) => ({ id: entry.id, message })),
  );
  return { ...context, messages: projectMessages(visible, blocks) };
}

function toolCalls(message: Message): ToolCall[] {
  return message.role === "assistant"
    ? message.content.filter((part): part is ToolCall => part.type === "toolCall")
    : [];
}

// ACP splits a multi-call assistant entry into one core message per call.
function coverageIds({ id, message }: VisibleMessage): string[] {
  const calls = toolCalls(message);
  return calls.length > 1 ? calls.map((call) => `${id}#${call.id}`) : [id];
}

function summaryMessage(block: AcpBlock): Message {
  return {
    role: "compactionSummary",
    summary: `[ACP block ${block.blockId} — ${block.effectiveMessageIds.length} folded messages]\n${block.summary}`,
    tokensBefore: 0,
    timestamp: 0,
  };
}

function projectMessages(visible: VisibleMessage[], blocks: AcpBlock[]): Message[] {
  const indexById = new Map<string, number>();
  visible.forEach((item, index) => {
    for (const id of coverageIds(item)) indexById.set(id, index);
  });
  const covered = new Set<string>();
  const anchors = new Map<number, AcpBlock[]>();
  for (const block of blocks) {
    const positions = block.effectiveMessageIds.flatMap((id) => {
      const index = indexById.get(id);
      return index === undefined ? [] : [index];
    });
    // A block belonging only to an inactive branch/native-compacted range
    // must not inject that branch's history into the current context.
    if (!positions.length) continue;
    const first = positions.reduce((left, right) => Math.min(left, right));
    anchors.set(first, [...(anchors.get(first) ?? []), block]);
    for (const id of block.effectiveMessageIds) covered.add(id);
  }
  if (!covered.size) return visible.map(({ message }) => message);

  // ACP protects the first user core message, including extension messages
  // that Pi exposes to the model as user content.
  const firstUser = visible.findIndex(({ message }) =>
    message.role === "user" || message.role === "custom",
  );
  const messages: Message[] = [];
  visible.forEach((item, index) => {
    for (const block of anchors.get(index) ?? []) messages.push(summaryMessage(block));
    const retained = index === firstUser ? item.message : retainUncovered(item, covered);
    if (retained) messages.push(retained);
  });
  return removeOrphanedTools(messages);
}

function retainUncovered(item: VisibleMessage, covered: Set<string>): Message | undefined {
  const ids = coverageIds(item);
  if (!ids.some((id) => covered.has(id))) return item.message;
  if (ids.every((id) => covered.has(id))) return undefined;
  const message = item.message;
  if (message.role !== "assistant") return message;
  // A partially folded tool batch keeps the original text and uncovered calls.
  return {
    ...message,
    content: message.content.filter((part) =>
      part.type !== "toolCall" || !covered.has(`${item.id}#${part.id}`),
    ),
  };
}

/** Match ACP's pair cleanup when compression crosses a tool-call boundary. */
function removeOrphanedTools(messages: Message[]): Message[] {
  const resultIds = new Set(messages.flatMap((message) =>
    message.role === "toolResult" ? [message.toolCallId] : [],
  ));
  const paired = messages.flatMap((message): Message[] => {
    const calls = toolCalls(message);
    if (!calls.length || message.role !== "assistant") return [message];
    const retained = calls.filter((call) => call.name === "compress" || resultIds.has(call.id));
    if (!retained.length) return [];
    const ids = new Set(retained.map((call) => call.id));
    return [{ ...message, content: message.content.filter((part) => part.type !== "toolCall" || ids.has(part.id)) }];
  });
  const callIds = new Set(paired.flatMap((message) => toolCalls(message).map((call) => call.id)));
  return paired.filter((message) => message.role !== "toolResult" || callIds.has(message.toolCallId));
}
