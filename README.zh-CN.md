# Pi Shadow Mind

![Pi Shadow Mind——主 Agent 负责构建，Shadow Minds 负责审阅、核验与维护](./assets/shadow-mind-hero-v2.png)

**为 Pi 配置多个独立的认知核心。**

[English](./README.md) · [中文](./README.zh-CN.md)

Pi Shadow Mind 让多个专业化认知核心与主 Agent 并行工作。每个 Shadow Mind 都拥有一项持续、稳定的职责，例如架构审阅、正确性检查、文档维护、项目事实核验，或任何由你定义的任务。

主 Agent 负责持续推进，其他认知核心则独立审阅决策、核验事实、维护相关文件，并在错误产生高昂返工成本之前介入。

> 让实现与审阅发生在同一轮工作中。

## 一个 Agent，多项独立职责

| 认知核心 | 职责 |
| --- | --- |
| 架构审阅 | 在编码过程中发现上帝组件、职责错位、模块边界缺失和脆弱的扩展点 |
| 项目事实核验 | 对照真实仓库检查结论，发现模型编造的 API、文件、约束和实现细节 |
| 文档维护 | 跟踪实现变化，让架构说明、设计决策和使用文档保持同步 |
| 完成度审阅 | 在主 Agent 宣布完成前，独立检查结果是否真正满足任务要求 |

它们不是主 Agent 临时委派的任务，而是由用户定义、持续存在的认知职责，可以独立决定何时检查、行动或汇报。

## Shadow 不只审阅，也可以工作

Shadow Mind 可以保持只读，只向主 Agent 汇报发现；也可以获得额外工具，独立负责另一条任务线。

当主 Agent 编写代码时，另一个 Shadow 可以同步维护文档、更新架构决策，或处理独立文件。工具权限由每个 Shadow 单独配置，因此每个认知核心只获得其职责真正需要的能力。

```text
主 Agent             Architecture Shadow
实现功能              审阅模块边界

主 Agent             Documentation Shadow
编写代码              维护设计文档
```

审阅只是一种职责。Shadow Mind 可以观察、核验、维护，也可以直接构建。

## 从 Architecture Shadow 开始

创建 `~/.pi/agent/shadow-minds/architecture-review.md`：

```markdown
---
id: architecture-review
name: Architecture review
activation_probability: 0.3
trigger: [heartbeat]
active_for_models: ["*"]
tools: [read, grep]
---

审阅主 Agent 当前实现是否正在偏离合理架构。

检查每项职责是否有明确所有者、模块边界是否内聚、新能力是否使用了合适的扩展点。
发现不断膨胀的上帝组件、堆积在同一模块中的无关状态与方法，以及用持续增长的条件
分支承载业务差异的实现。

只报告能够从当前轨迹或仓库中得到证据、并且可以采取行动的问题。如果当前工作与该职责
无关，不要介入。
```

这个 Shadow 默认只读。它会在实现过程中并行审阅架构，并向主 Agent 报告具体问题，但不会接管主任务。`tools` 中的名称会追加到默认只读工具集；只有确实需要继承 Main Session 当前注册的全部工具（包括未来新增工具）时，才使用 `tools: ["*"]`。

## 工作方式

每个 Shadow 可以通过 `trigger` 选择一种或两种激活方式。默认值是 `[heartbeat]`：主 Agent 的一次 `turn_end` 只有在该轮至少完成过一个工具调用时，扩展才进行全局 heartbeat 概率判断，符合条件的 Shadow 再按照各自的 `activation_probability` 独立抽选。纯文本对话轮次不会触发 heartbeat。可以通过全局配置 `heartbeat_tools` 进一步限定哪些工具调用才能触发心跳判断（默认留空不限制）；也可以在单个 Shadow 中配置 `activation_tools` 限定只有该轮包含特定工具调用时才具备候选资格（默认留空不限制）。

使用 `trigger: [final_response]` 可以进行完成后审查。它在主 Agent 发出最终文字并完全 settled 后激活，不受 heartbeat 和 `activation_probability` 影响。同一最终回复的全部检查结束后，发现会合并为一次 `shadow-report` follow-up，较慢的同批检查不会介入已经修订的回复。`trigger: [heartbeat, final_response]` 会同时启用两种模式。`max_parallel_shadows` 仍然限制并发数；超出并发槽位的最终回复检查会排队，而不会被跳过。

每次激活都会创建一个全新的临时 Session。它继承主 Agent 原封不动的 system prompt，但只接收净化后的文本轨迹：思考内容会被移除，工具调用后仅保留简洁、确定性的结果概述。

Shadow 会先判断轨迹是否与自己的职责相关。无关时直接结束，不调用工具或 `report_to_main`；需要向主 Agent 提交具体结果时，通过 `report_to_main` 上报并立即结束本轮。

Shadow 定义只是普通 Markdown 文件，可以由用户创建和调整，也可以由 Agent 通过扩展工具管理。模型过滤和独立激活概率允许不同模型获得不同的辅助认知核心。

## 安装

```bash
pi install npm:pi-shadow-mind
```

首次启动 Session 时，扩展会创建：

```text
~/.pi/agent/shadow-minds/
  config.json
  *.md
  logs/<shadow-id>/*.jsonl   # 仅在 debug: true 时生成
```

扩展不会默认创建 Shadow Mind。全局默认运行超时为 300 秒，单个 Shadow 可以通过 `timeout_seconds` 覆盖。

按 `F6` 或 `Alt+S` 可以暂停或恢复当前 Session 的 Shadow Mind。macOS 上可能需要按 `Fn+F6`；`Alt+S` 对应 `Option+S`，是否生效取决于终端的 Option 键映射。暂停时底部状态显示为 `🐙 Paused`，不再显示没有信息量的零计数。使用 `/shadow` 显示或隐藏状态面板，`/shadow status` 查看摘要，也可以通过 `/shadow toggle`、`/shadow pause` 和 `/shadow resume` 控制状态。管理工具可以查询、创建、更新、启用、禁用和删除 Shadow Mind，以及读取或修改全局配置。所有写操作都需要用户确认。

## 在 DSH 中使用

如果希望在 DSH 中使用 Shadow Mind，请前往 [`whutzefengxie-ops/dsh-shadow-mind`](https://github.com/whutzefengxie-ops/dsh-shadow-mind)。该项目提供了面向 DSH 的集成实现。

## 开发

```powershell
npm install
pi -e ./src/index.ts
```

完整行为约定见 [DESIGN.md](./DESIGN.md)，Benchmark 方法与经验见 [BENCHMARK.md](./BENCHMARK.md)。
