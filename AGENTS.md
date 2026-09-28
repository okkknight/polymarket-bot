# AGENTS.md

本文件是给 AI agents（如 Codex、OpenClaw）看的仓库操作规则。

适用项目：Polymarket 自动交易系统

---

## 1. Repo Purpose

This repository contains an automated trading system for Polymarket.

当前项目重点：
- 小额 live trading 前的工程稳定性完善
- recovery / reconciliation / execution quality
- 风险控制与可观测性
- 避免过度策略优化

---

## 2. Agent Roles

### Codex
负责：
- 实现代码
- 修复 bug
- 运行自测
- 提交 PR

不负责：
- 最终功能验收
- 最终项目文档裁定
- 未经批准的架构重构

### OpenClaw
负责：
- code review
- 功能验收（functional acceptance）
- 更新项目文档
- 记录工程决策与已知风险

不负责：
- 在 review 阶段进行大规模投机性重写

---

## 3. High-Level Architecture Boundaries

关键模块通常包括（按实际 repo 调整）：
- strategy
- execution
- recovery
- reconciliation
- ledger / state
- risk control
- logging / metrics

### Critical rule
未经人类明确批准，不要修改以下高风险区域的核心语义：
- strategy logic
- risk control semantics
- order sizing policy
- market selection policy
- fund / balance safety rules
- production secrets or auth handling

---

## 4. Development Constraints

AI agents 必须遵守：

- 优先小改动（small diffs）
- 不修改无关模块
- 不引入新依赖，除非明确批准
- 不改变数据库 / storage schema，除非明确批准
- 不静默修改外部行为
- 不伪造测试结果
- 如果无法验证，必须明确说明

---

## 5. Validation Expectations

在可行情况下，Codex 应主动运行并报告：

```bash
npm test
npm run lint
npm run build
```

如果某条命令不存在或当前环境无法执行，必须在输出中明确说明：
- 哪条命令未执行
- 为什么未执行
- 当前是否存在替代验证方式

---

## 6. Polymarket-Specific Guardrails

### 6.1 Trading Safety
以下改动默认需要人类批准：
- 改变下单策略语义
- 改变价格计算逻辑
- 改变订单生命周期状态机
- 改变 recovery 的最终一致性语义
- 改变 reconciliation 的 timeout / convergence policy
- 改变 live trading 风险阈值
- 执行实盘交易测试

### 6.2 Recovery / Reconciliation
对 recovery / reconciliation 相关改动，优先关注：
- idempotency
- bounded convergence
- ledger correctness
- duplicate prevention
- crash recovery safety
- diagnosability via logs

### 6.3 Logging
涉及关键行为变化时，应保证：
- 日志足够帮助排障
- 关键决策点有明确日志
- 错误信息可定位问题

---

## 7. Working Conventions

### Branching
使用极简分支策略：
- `main`
- `task/*`

规则：
- 1 task = 1 branch = 1 PR
- review 打回后，在同一个 `task/*` 分支继续修复
- 不额外创建复杂辅助分支

### Task Specs
所有任务说明放在：
- `tasks/`

建议命名：
- `TASK_YYYYMMDD_<short_name>.md`

### Long-Lived Docs
长期文档放在：
- `docs/PROJECT_CONTEXT.md`
- `docs/ARCHITECTURE.md`
- `docs/CHANGELOG.md`
- `docs/ENGINEERING_LOG.md`

---

## 8. Expected Output Format

### Codex 输出应包含
- Summary
- Files Changed
- Validation Run
- Risks / Limitations

### OpenClaw 输出应包含
- Review Verdict
- Functional Acceptance Verdict
- Key Findings
- Required Fixes（如有）
- Doc Updates Performed（如有）

---

## 9. If Uncertain

如果 agent 对任务存在不确定性，应：
1. 优先缩小改动范围
2. 明确写出假设
3. 明确写出未验证项
4. 避免自行扩大任务范围

---

## 10. Short Version

在这个 repo 里：
- Human 定义任务与做最终决策
- Codex 写代码并自测
- OpenClaw review、验收、更新文档
- 没有验证和验收，就不算完成
