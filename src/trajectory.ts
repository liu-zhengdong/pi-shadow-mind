import { summarizeToolResult } from "./summaries.js";

type MessageLike = { role?: string; content?: unknown; [key: string]: unknown };

export function serializeTrajectory(messages: readonly MessageLike[]): string {
  const results = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      results.set(message.toolCallId, summarizeToolResult(message));
    }
  }

  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      appendText(lines, "USER", message.content);
      continue;
    }
    if (message.role === "assistant") {
      if (!Array.isArray(message.content)) {
        appendText(lines, "MAIN", message.content);
        continue;
      }
      for (const block of message.content) {
        if (!block || typeof block !== "object" || isThinkingBlock(block)) continue;
        const item = block as { type?: string; text?: string; id?: string; name?: string; arguments?: unknown };
        if (item.type === "text" && item.text) lines.push(`MAIN: ${item.text}`);
        if (item.type === "toolCall" && item.name) {
          const call = `${item.name}(${compactJson(item.arguments)})`;
          const result = item.id ? results.get(item.id) : undefined;
          lines.push(`TOOL: ${call}${result ? ` · ${result}` : ""}`);
        }
      }
      continue;
    }
    if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || !results.has(message.toolCallId)) {
        lines.push(`TOOL RESULT: ${summarizeToolResult(message)}`);
      }
      continue;
    }
    if (message.role === "custom" && message.customType === "shadow-report") {
      appendText(lines, "SHADOW FEEDBACK", message.content);
      continue;
    }
    if (message.role === "compactionSummary" || message.role === "branchSummary") {
      appendText(lines, "SUMMARY", message.summary ?? message.content);
    }
  }
  return `<main-agent-trajectory>\n${lines.join("\n")}\n</main-agent-trajectory>`;
}

export function sanitizeTrajectory(messages: readonly MessageLike[]): MessageLike[] {
  return messages.flatMap((message) => {
    if (message.role === "assistant") {
      const content = Array.isArray(message.content)
        ? message.content.filter((block) => !isThinkingBlock(block)).map(clone)
        : message.content;
      return [{ ...clone(message), content }];
    }
    if (message.role === "toolResult") {
      return [{
        ...clone(message),
        content: [{ type: "text", text: summarizeToolResult(message) }],
        details: undefined,
        usage: undefined,
      }];
    }
    if (message.role === "custom") {
      return message.customType === "shadow-report" ? [clone(message)] : [];
    }
    if (message.role === "user" || message.role === "compactionSummary" || message.role === "branchSummary") {
      return [clone(message)];
    }
    return [];
  });
}

function isThinkingBlock(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && (value as { type?: string }).type === "thinking";
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function appendText(lines: string[], label: string, content: unknown): void {
  const text = extractText(content);
  if (text) lines.push(`${label}: ${text}`);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type?: string; text?: string } => Boolean(item) && typeof item === "object")
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function compactJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}
