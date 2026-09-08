import { describe, expect, it } from "vitest";
import { parseShadowMarkdown } from "../src/registry.js";

describe("parseShadowMarkdown", () => {
  it("applies shadow defaults", () => {
    const shadow = parseShadowMarkdown(
      "---\nname: Fact checker\n---\nCheck claims against the project.",
      "C:/tmp/facts.md",
    );
    expect(shadow).toMatchObject({
      id: "facts",
      name: "Fact checker",
      enabled: true,
      debug: false,
      activationProbability: 0.3,
      trigger: ["heartbeat"],
      activeForModels: ["*"],
      tools: [],
      activationTools: [],
    });
  });

  it("parses activation_tools", () => {
    const shadow = parseShadowMarkdown(
      "---\nid: write-checker\nactivation_tools: [bash, edit, write]\n---\nReview changes.",
      "C:/tmp/write-checker.md",
    );
    expect(shadow.activationTools).toEqual(["bash", "edit", "write"]);
  });

  it("parses final_response_rounds and defaults to unlimited", () => {
    const unlimited = parseShadowMarkdown(
      "---\nid: unlimited\ntrigger: final_response\n---\nReview completion.",
      "C:/tmp/unlimited.md",
    );
    const limited = parseShadowMarkdown(
      "---\nid: limited\ntrigger: final_response\nfinal_response_rounds: 1\n---\nReview completion.",
      "C:/tmp/limited.md",
    );
    const explicitUnlimited = parseShadowMarkdown(
      "---\nid: explicit-unlimited\nfinal_response_rounds: 0\n---\nReview completion.",
      "C:/tmp/explicit-unlimited.md",
    );
    expect(unlimited.finalResponseRounds).toBeUndefined();
    expect(limited.finalResponseRounds).toBe(1);
    expect(explicitUnlimited.finalResponseRounds).toBe(0);
  });

  it("rejects invalid final_response_rounds", () => {
    expect(() =>
      parseShadowMarkdown(
        "---\nid: bad\nfinal_response_rounds: -1\n---\nReview.",
        "C:/tmp/bad-rounds.md",
      ),
    ).toThrow(/final_response_rounds/);
    expect(() =>
      parseShadowMarkdown(
        "---\nid: bad\nfinal_response_rounds: 1.5\n---\nReview.",
        "C:/tmp/bad-rounds.md",
      ),
    ).toThrow(/final_response_rounds/);
  });

  it("rejects invalid activation_tools", () => {
    expect(() =>
      parseShadowMarkdown(
        "---\nid: bad-tools\nactivation_tools: [123]\n---\nReview.",
        "C:/tmp/bad.md",
      ),
    ).toThrow(/activation_tools/);
  });

  it("accepts one or multiple activation triggers", () => {
    const single = parseShadowMarkdown(
      "---\nid: final-check\ntrigger: final_response\n---\nReview completion.",
      "C:/tmp/final.md",
    );
    const multiple = parseShadowMarkdown(
      "---\nid: both\ntrigger: [heartbeat, final_response]\n---\nReview progress.",
      "C:/tmp/both.md",
    );
    expect(single.trigger).toEqual(["final_response"]);
    expect(multiple.trigger).toEqual(["heartbeat", "final_response"]);
  });

  it("rejects unknown activation triggers", () => {
    expect(() =>
      parseShadowMarkdown(
        "---\nid: invalid\ntrigger: manual\n---\nReview.",
        "C:/tmp/invalid.md",
      ),
    ).toThrow(/invalid trigger/);
  });

  it("rejects an empty prompt", () => {
    expect(() =>
      parseShadowMarkdown("---\nid: empty\n---\n", "C:/tmp/empty.md"),
    ).toThrow(/empty/);
  });

  it("accepts off as a thinking level", () => {
    const shadow = parseShadowMarkdown(
      "---\nid: quick-check\nthinking_level: off\n---\nCheck once and report.",
      "C:/tmp/quick-check.md",
    );
    expect(shadow.thinkingLevel).toBe("off");
  });
});
