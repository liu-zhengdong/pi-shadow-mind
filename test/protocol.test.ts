import { describe, expect, it } from "vitest";
import {
  buildShadowRequest,
  buildShadowSystemPrompt,
} from "../src/protocol.js";
import type { ShadowDefinition } from "../src/types.js";

describe("Shadow runtime protocol", () => {
  it("marks the injected trajectory as the main agent's read-only transcript", () => {
    const shadow: ShadowDefinition = {
      id: "reviewer",
      name: "Reviewer",
      enabled: true,
      debug: false,
      activationProbability: 0.3,
      trigger: ["heartbeat"],
      activeForModels: ["*"],
      tools: [],
      activationTools: [],
      prompt: "Review progress.",
      filePath: "reviewer.md",
    };
    const prompt = buildShadowSystemPrompt("main system");
    expect(prompt).toBe("main system");
    const request = buildShadowRequest(
      "<main-agent-trajectory>\nUSER: task\n</main-agent-trajectory>",
      shadow,
    );
    expect(request).toContain("Never continue the main agent's pending work");
    expect(request).toContain('<shadow-mind id="reviewer"');
    expect(request).toContain(
      "reply exactly NOT_RELEVANT and stop immediately",
    );
    expect(request).toContain("Do not call any tool, including report_to_main");
  });

  it("combines trajectory, identity and kickoff into one user request", () => {
    const request = buildShadowRequest(
      "<main-agent-trajectory>\nUSER: task\n</main-agent-trajectory>",
      {
        id: "reviewer",
        name: "Reviewer",
        enabled: true,
        debug: false,
        activationProbability: 0.3,
        trigger: ["heartbeat"],
        activeForModels: ["*"],
        tools: [],
        activationTools: [],
        prompt: "Review progress.",
        filePath: "reviewer.md",
      },
    );
    expect(request).toContain("USER: task");
    expect(request).toContain("Review progress.");
    expect(request).toMatch(
      /First decide whether the trajectory is relevant[^]*Call report_to_main only when the main agent should receive a result\.$/,
    );
  });
});
