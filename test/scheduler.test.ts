import { describe, expect, it } from "vitest";
import {
  decideFinalResponse,
  decideHeartbeat,
  extractToolNames,
  matchesActivationTools,
  shouldEvaluateFinalResponse,
  shouldEvaluateHeartbeat,
} from "../src/scheduler.js";
import type { ShadowDefinition } from "../src/types.js";

const shadow = (
  id: string,
  probability = 1,
  trigger: ShadowDefinition["trigger"] = ["heartbeat"],
  activationTools: string[] = [],
  finalResponseRounds?: number,
): ShadowDefinition => ({
  id,
  name: id,
  enabled: true,
  debug: false,
  activationProbability: probability,
  trigger,
  activeForModels: ["openai/gpt"],
  ...(finalResponseRounds !== undefined ? { finalResponseRounds } : {}),
  tools: [],
  activationTools,
  prompt: id,
  filePath: `${id}.md`,
});

describe("shouldEvaluateHeartbeat", () => {
  it("suppresses pure conversation turns", () => {
    expect(shouldEvaluateHeartbeat([])).toBe(false);
  });

  it("allows turns that completed Main tool work", () => {
    expect(shouldEvaluateHeartbeat([{ toolName: "read" }])).toBe(true);
  });

  it("respects heartbeatTools filter", () => {
    expect(
      shouldEvaluateHeartbeat([{ toolName: "read" }], ["bash", "write"]),
    ).toBe(false);
    expect(
      shouldEvaluateHeartbeat([{ toolName: "bash" }], ["bash", "write"]),
    ).toBe(true);
    expect(
      shouldEvaluateHeartbeat(
        [{ toolName: "read" }, { toolName: "write" }],
        ["bash", "write"],
      ),
    ).toBe(true);
  });
});

describe("extractToolNames", () => {
  it("extracts and trims valid tool names", () => {
    const names = extractToolNames([
      { toolName: "bash" },
      { toolName: " edit " },
      null,
      {},
      { toolName: "" },
    ]);
    expect(names).toEqual(new Set(["bash", "edit"]));
  });
});

describe("matchesActivationTools", () => {
  it("allows all when activationTools is empty", () => {
    const s = shadow("s");
    expect(matchesActivationTools(s, ["read"])).toBe(true);
    expect(matchesActivationTools(s, undefined)).toBe(true);
  });

  it("requires intersection when activationTools is specified", () => {
    const s = shadow("s", 1, ["heartbeat"], ["bash", "edit", "write"]);
    expect(matchesActivationTools(s, ["read"])).toBe(false);
    expect(matchesActivationTools(s, ["read", "edit"])).toBe(true);
  });
});

describe("shouldEvaluateFinalResponse", () => {
  it("accepts an agent run ending with final assistant text", () => {
    expect(
      shouldEvaluateFinalResponse([
        { role: "user", content: "task" },
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
      ]),
    ).toBe(true);
  });

  it("rejects tool-only, empty, and aborted endings", () => {
    expect(
      shouldEvaluateFinalResponse([
        { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
      ]),
    ).toBe(false);
    expect(
      shouldEvaluateFinalResponse([
        { role: "assistant", content: [{ type: "text", text: "  " }] },
      ]),
    ).toBe(false);
    expect(shouldEvaluateFinalResponse([])).toBe(false);
  });
});

describe("decideHeartbeat", () => {
  it("rolls independently and caps selected shadows", () => {
    const rolls = [0.1, 0.1, 0.2, 0.3, 0.8, 0.4];
    const result = decideHeartbeat({
      heartbeatProbability: 1 / 3,
      availableSlots: 2,
      shadows: [shadow("a"), shadow("b"), shadow("c")],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      random: () => rolls.shift() ?? 0,
    });
    expect(result.activated).toHaveLength(2);
    expect(result.candidates).toHaveLength(3);
  });

  it("does nothing when heartbeat misses", () => {
    const result = decideHeartbeat({
      heartbeatProbability: 0.3,
      availableSlots: 2,
      shadows: [shadow("a")],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      random: () => 0.5,
    });
    expect(result.activated).toEqual([]);
  });

  it("reports running-excluded and model-filtered shadows", () => {
    const result = decideHeartbeat({
      heartbeatProbability: 1,
      availableSlots: 2,
      shadows: [shadow("a"), shadow("b")],
      activeShadowIds: new Set(["a"]),
      mainModelId: "other/model",
      random: () => 0.1,
    });
    expect(result.runningExcluded).toEqual(["a"]);
    expect(result.modelFiltered).toEqual(["b"]);
    expect(result.activated).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it("filters shadows by activationTools and records toolFiltered", () => {
    const writeOnlyShadow = shadow("writer", 1, ["heartbeat"], ["bash", "edit", "write"]);
    const generalShadow = shadow("general", 1, ["heartbeat"], []);

    // Case 1: Only "read" was called -> writeOnlyShadow is toolFiltered
    const readTurnResult = decideHeartbeat({
      heartbeatProbability: 1,
      availableSlots: 2,
      shadows: [writeOnlyShadow, generalShadow],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      executedTools: ["read"],
      random: () => 0.1,
    });
    expect(readTurnResult.toolFiltered).toEqual(["writer"]);
    expect(readTurnResult.activated.map((a) => a.shadow.id)).toEqual(["general"]);

    // Case 2: "edit" was called -> writeOnlyShadow is activated
    const editTurnResult = decideHeartbeat({
      heartbeatProbability: 1,
      availableSlots: 2,
      shadows: [writeOnlyShadow, generalShadow],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      executedTools: ["edit"],
      random: () => 0.1,
    });
    expect(editTurnResult.toolFiltered).toEqual([]);
    expect(
      editTurnResult.activated.map((a) => a.shadow.id).sort(),
    ).toEqual(["general", "writer"]);
  });

  it("verifies user scenario: default global config + shadow with activation_tools=[bash, edit, write] and p=1", () => {
    const s = shadow("reviewer", 1, ["heartbeat"], ["bash", "edit", "write"]);

    // Turn with 'read' only: heartbeat rolls 0.1 (< 1/3 hit), but shadow excluded by toolFiltered
    const readTurn = decideHeartbeat({
      heartbeatProbability: 1 / 3,
      availableSlots: 2,
      shadows: [s],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      executedTools: ["read"],
      random: () => 0.1,
    });
    expect(readTurn.activated).toHaveLength(0);
    expect(readTurn.toolFiltered).toEqual(["reviewer"]);

    // Turn with 'bash': heartbeat rolls 0.1 (< 1/3 hit), shadow tool matches, roll 0.2 (< 1 hit) -> activated
    const rolls = [0.1, 0.2];
    const bashTurn = decideHeartbeat({
      heartbeatProbability: 1 / 3,
      availableSlots: 2,
      shadows: [s],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      executedTools: ["bash"],
      random: () => rolls.shift() ?? 0,
    });
    expect(bashTurn.activated).toHaveLength(1);
    expect(bashTurn.activated[0].shadow.id).toBe("reviewer");

    // Turn with 'bash': heartbeat rolls 0.5 (>= 1/3 miss) -> no activation
    const bashMissTurn = decideHeartbeat({
      heartbeatProbability: 1 / 3,
      availableSlots: 2,
      shadows: [s],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      executedTools: ["bash"],
      random: () => 0.5,
    });
    expect(bashMissTurn.activated).toHaveLength(0);
  });
});

describe("decideFinalResponse", () => {
  it("activates final-response shadows without probability rolls or activation-tools filtering", () => {
    const result = decideFinalResponse({
      shadows: [
        shadow("heartbeat"),
        shadow("final-a", 0, ["final_response"], ["write"]),
        shadow("final-b", 0, ["heartbeat", "final_response"], ["edit"]),
      ],
      mainModelId: "openai/gpt",
    });
    expect(result.activated.map(({ shadow }) => shadow.id)).toEqual([
      "final-a",
      "final-b",
    ]);
    expect(result.candidates.every(({ selected }) => selected)).toBe(true);
  });

  it("still applies enabled and model filters", () => {
    const disabled = {
      ...shadow("disabled", 1, ["final_response"]),
      enabled: false,
    };
    const otherModel = {
      ...shadow("other", 1, ["final_response"]),
      activeForModels: ["other/model"],
    };
    const result = decideFinalResponse({
      shadows: [disabled, otherModel],
      mainModelId: "openai/gpt",
    });
    expect(result.activated).toEqual([]);
    expect(result.modelFiltered).toEqual(["other"]);
  });

  it("filters a Shadow after its final-response round limit", () => {
    const limited = shadow("limited", 1, ["final_response"], [], 1);
    const unlimited = shadow("unlimited", 1, ["final_response"]);
    const result = decideFinalResponse({
      shadows: [limited, unlimited],
      mainModelId: "openai/gpt",
      finalResponseRounds: new Map([["limited", 1]]),
    });
    expect(result.activated.map(({ shadow }) => shadow.id)).toEqual([
      "unlimited",
    ]);
    expect(result.roundFiltered).toEqual(["limited"]);
  });
});
