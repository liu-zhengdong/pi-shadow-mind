# Pi Shadow Mind

![Pi Shadow Mind — the main agent builds while Shadow Minds review, verify, and maintain](./assets/shadow-mind-hero-v2.png)

**Configurable cognitive cores for Pi.**

[English](./README.md) · [中文](./README.zh-CN.md)

Pi Shadow Mind runs specialized agents alongside the main agent. Each Shadow Mind owns a persistent responsibility—architecture, correctness, documentation, project grounding, or anything else you define.

While the main agent implements, other minds can independently review decisions, verify claims, maintain related files, and intervene before mistakes become expensive to undo.

> Build and review in the same pass.

## One agent, multiple responsibilities

The main agent keeps moving. Shadow Minds independently protect the parts of the work that matter to you.

| Cognitive core | Responsibility |
| --- | --- |
| Architecture review | Detect growing god components, misplaced responsibilities, missing module boundaries, and fragile extension points while code is being written |
| Project grounding | Check claims against the actual repository and catch invented APIs, files, constraints, or implementation details |
| Documentation maintenance | Track implementation changes and keep architecture notes, decisions, and usage documentation aligned |
| Completion review | Independently verify that the result satisfies the task before the main agent declares it finished |

These are not temporary tasks delegated by the main agent. They are persistent, user-defined cognitive roles that decide independently when to inspect, act, or report.

## Shadows can review—or work

A Shadow Mind may remain read-only and report findings to the main agent, or receive additional tools and own a parallel line of work.

While the main agent writes code, another Shadow can maintain documentation, update architectural decisions, or work on a separate file. Tool access is configured per Shadow, so each cognitive core receives only the capabilities its responsibility requires.

```text
Main Agent          Architecture Shadow
implements feature  reviews module boundaries

Main Agent          Documentation Shadow
writes code         maintains design documentation
```

Review is only one possible responsibility. A Shadow Mind can observe, verify, maintain, or build.

## Start with an Architecture Shadow

Create `~/.pi/agent/shadow-minds/architecture-review.md`:

```markdown
---
id: architecture-review
name: Architecture review
activation_probability: 0.3
trigger: [heartbeat]
active_for_models: ["*"]
tools: [read, grep]
---

Review the main agent's current implementation for architectural drift.

Check whether responsibilities have clear owners, modules have coherent
boundaries, and new behavior uses appropriate extension points. Detect growing
god components, unrelated state or methods accumulating in one module, and
business differences implemented as expanding conditionals.

Report only concrete, actionable issues grounded in the visible trajectory or
repository. If the current work is unrelated, do not intervene.
```

This Shadow is read-only. It reviews the implementation in parallel and reports concrete architectural concerns without taking control of the main task. Tool names extend the default read-only set; use `tools: ["*"]` only when the Shadow should inherit every tool currently registered in the main session, including tools added later.

## How it works

Each Shadow chooses one or both activation triggers with `trigger`. The default is `[heartbeat]`: after a main-agent `turn_end` that completed at least one tool call, the extension evaluates the global heartbeat probability, then eligible Shadows roll independently using `activation_probability`. Pure text-only conversation turns are skipped.

Use `trigger: [final_response]` for completion review. It activates after the main agent has emitted its final text and bypasses both heartbeat and activation probability. All checks for that final response finish before their findings are sent together through one `shadow-report` follow-up, so a slow sibling cannot leak into a revised answer. `trigger: [heartbeat, final_response]` enables both modes. `max_parallel_shadows` remains the concurrency limit; excess final-response checks are queued rather than skipped.

Each activation starts a fresh temporary session. It inherits the main agent's unchanged system prompt but receives only a sanitized plain-text trajectory: assistant thinking is removed, while tool calls retain compact, deterministic result summaries.

A Shadow first decides whether the trajectory is relevant to its responsibility. If unrelated, it exits without calling tools or `report_to_main`. When the main agent should receive a concrete result, the Shadow calls `report_to_main`, which immediately ends that run.

Shadow definitions are ordinary Markdown files. They can be created and adjusted by the user or managed by the agent through the extension's tools. Model filters and activation probabilities allow different models to receive different supporting minds.

## Installation

```bash
pi install npm:pi-shadow-mind
```

On the first session start, the extension creates:

```text
~/.pi/agent/shadow-minds/
  config.json
  *.md
  logs/<shadow-id>/*.jsonl   # only when debug: true
```

No default Shadow Mind is created. The global runtime timeout defaults to 300 seconds, and individual Shadows may override it with `timeout_seconds`.

Press `F6` or `Alt+S` to pause or resume Shadow Mind for the current session. On macOS, you may need `Fn+F6`; `Alt+S` corresponds to `Option+S` and depends on the terminal's Option key mapping. The paused footer reads `⏸ Paused` without a redundant zero count. Use `/shadow` to toggle the status panel, `/shadow status` for a summary, or `/shadow toggle`, `/shadow pause`, and `/shadow resume` for command-based control. Report bodies are hidden by default; use `/shadow reports` to toggle their visibility under the matching recent run in the status panel, or `/shadow reports hide` to hide them. Management tools can list, create, update, enable, disable, and delete Shadow Minds, as well as read or update the global configuration. Every write requires user confirmation.

## Using with DSH

To use Shadow Mind in DSH, see [`whutzefengxie-ops/dsh-shadow-mind`](https://github.com/whutzefengxie-ops/dsh-shadow-mind). That project provides the DSH-specific integration.

## Development

```powershell
npm install
pi -e ./src/index.ts
```

See [DESIGN.md](./DESIGN.md) for the behavioral contract and [BENCHMARK.md](./BENCHMARK.md) for benchmark methodology and lessons learned.
