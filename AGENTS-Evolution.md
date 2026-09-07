# AGENTS Evolution

## 2026-09-04 · 将正式发布交给 tag 自动化

- 发生：本地八步发布流程与已经建立的 GitHub Release workflow 重复执行验证、构建、打包和发布。
- 分析：重复工作增加时间和人为差异；正式产物应由一个可复现的自动化边界统一生成。
- 改变：本地流程缩减为更新版本、提交并推送、推送匹配 tag；CI 负责完整验证、产物、冒烟、校验和、npm OIDC 发布及 GitHub Release。

## 2026-09-04 · 删除普通交付的统一质量门禁

- 发生：`Delivery quality gate` 要求每次普通交付都运行 release 级全量检查，持续成本过高。
- 分析：不同改动需要与风险相称的验证；tag 发布已有完整自动门禁，无需让所有本地任务重复承担。
- 改变：从项目规则删除统一 gate，普通任务采用按需验证，正式发布继续由 workflow 执行完整检查。

## 2026-09-04 · 缩短 Release workflow

- 发生：v0.1.17 发布耗时 3 分 54 秒，其中 `npm ci` 占 204 秒。
- 分析：共享 npm cache 会让可变缓存跨过 OIDC 发布边界并触发 cache-poisoning；应优化非特权执行路径而不削弱隔离。
- 改变：保留 cache isolation，关闭 lifecycle scripts、audit 与 funding 请求，并行运行 verify/build；v0.1.18 workflow 降至 31 秒。
