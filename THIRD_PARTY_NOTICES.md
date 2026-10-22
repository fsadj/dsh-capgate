# 第三方组件与许可（THIRD_PARTY_NOTICES）

本项目在开发过程中参考并**部分移植**了以下开源工作。按 MIT 许可要求，保留其版权声明。

---

## 1. ScopeJudge（MIT）

- 仓库：https://github.com/dreadnode/scopejudge
- 论文：*ScopeJudge: Cost-Aware Pre-Execution Gating for Offensive Security Agents*（arXiv:2607.07774）
- 版权：Copyright (c) 2026 Dreadnode
- 许可证全文：`_refs/scopejudge/LICENSE`

**借鉴内容**
- "执行前门禁 + 转录投影"的问题形式化；
- 五种上下文投影策略的思路（static / intent / intent+calls / intent+summary / full）；
- 其公开数据集（4,897 调用、377 越界、5 位专家标注）作为**外部评测集**（未打包进发行物）。

**未拷贝代码**：语言不同（Python → JavaScript），仅移植设计。

---

## 2. ClawSentry（MIT）

- 仓库：https://github.com/Elroyper/ClawSentry
- 论文：*ClawSentry: A Progressive Multi-Tier Security Monitor for Safeguarding Autonomous LLM Agents*（arXiv:2608.21101）
- 版权：Copyright (c) 2026 ClawSentry Contributors
- 许可证全文：`_refs/ClawSentry/LICENSE`

**借鉴内容（算法层面移植，非代码拷贝）**
- 三层渐进（L1 确定性 → L2 语义审查 → L3 只读取证 agent）的分层与"只对残余歧义花上下文"的原则；
- `AntiBypassRecord` / `DeniedEffectMemoryRecord` 的思想 → 本仓库 `src/bypass.mjs`（效果指纹 + TTL，独立实现）；
- `coverage_guard` / `strict_final` 的思想 → 本仓库 `reviewer.mjs` 的 `checkCoverage`；
- `FailureClass` 分类思想 → 本仓库 `src/failures.mjs`；
- 效果带置信度（`confidence: low/medium/high`）→ 本仓库 `classify.mjs` 的 `effect.confidence`。

**未拷贝代码**：`shell_model.py`（4,098 行逐工具解析器）、`gateway/`、`adapters/`、`fspr/` 均未移植。

---

## 3. AmPermBench / cc-auto-mode-measurement（README 标注 MIT，仓库内无 LICENSE 文件）

- 仓库：https://github.com/yan5ui/cc-auto-mode-measurement
- 论文：*Measuring the Permission Gate: A Stress-Test Evaluation of Claude Code's Auto Mode*（arXiv:2604.04978）

**借鉴内容**
- 机械 oracle 的构造（授权集合 = ticket + owner + lane 的机械匹配）；
- 三条歧义轴（具体度 / 影响面 / 风险级）的评测设计。

**未拷贝代码**：本仓库 `bench/amperm/` 为独立实现（本地目录 + `.cmd` shim，无 Docker）。

---

## 4. 其他参考（未使用代码）

- *Reinforced Agent: Inference-Time Feedback for Tool-Calling Agents*（arXiv:2604.27233）
- *AgentSpec: Customizable Runtime Enforcement for Safe and Reliable LLM Agents*（arXiv:2503.18666）

论文 PDF 仅用于阅读，存放于 `_refs/papers/`（不随发行物分发）。
