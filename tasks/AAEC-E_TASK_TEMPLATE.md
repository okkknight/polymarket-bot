# AAEC-E Task Template

> 用途：给 Polymarket 项目的单个任务使用。
> 
> 建议保存路径：`tasks/TASK_YYYYMMDD_<short_name>.md`

---

# Task: <task_name>

## 0. Task Summary

一句话目标：
<例如：将 unconfirmed_recovered_holdings 的处理从 fail-fast 改为 bounded convergence>

---

## 1. Step for Codex

### Agent
Codex

### Action
<要实现什么>

### Expectation
<成功结果是什么>

### Context
相关文件：
- <file_1>
- <file_2>
- <file_3>

相关背景：
- <当前设计约束>
- <为什么要做这个任务>

约束：
- 不要修改无关模块
- 不要修改 strategy logic（除非明确批准）
- 不要引入新依赖（除非明确批准）

### Evaluation
请在可行情况下运行：

```bash
npm test
npm run lint
npm run build
```

如果不能运行，请明确说明：
- 哪条命令未运行
- 为什么未运行
- 当前替代验证方式是什么

---

## 2. Step for OpenClaw — Review

### Agent
OpenClaw

### Action
Review Codex implementation.

### Expectation
- 逻辑正确
- 没有明显 architecture violation
- 没有明显 scope drift
- 没有遗漏关键边界情况

### Context
重点检查：
- 是否真正符合任务目标
- 是否修改了不该修改的部分
- 是否存在 recovery / reconciliation 风险
- 是否有需要补充的日志或诊断信息

### Evaluation
请输出：
- Review Verdict: Accept / Reject / Accept with follow-up
- Key Findings
- Required Fixes（如有）

---

## 3. Step for OpenClaw — Functional Acceptance

### Agent
OpenClaw

### Action
Perform functional acceptance against this task spec.

### Expectation
该功能应满足本任务目标，并且关键 acceptance criteria 成立。

### Context
验收关注点：
- 目标行为是否实现
- 失败行为是否可接受
- 日志是否足够帮助排障
- 是否仍有未验证假设

### Evaluation
请输出：
- Functional Acceptance Verdict: Pass / Partial Pass / Fail
- Acceptance Findings
- Remaining Unverified Items（如有）

---

## 4. Optional Project Doc Updates

如果本任务影响项目状态或重要决策，请让 OpenClaw 按需更新：
- `docs/PROJECT_CONTEXT.md`
- `docs/ARCHITECTURE.md`
- `docs/CHANGELOG.md`
- `docs/ENGINEERING_LOG.md`

---

## 5. Human Approval Rule

以下情况默认需要人类明确批准：
- 改 strategy logic
- 改 risk control semantics
- 改 live trading 风险参数
- 改 recovery 的最终一致性语义
- 改 order lifecycle 核心状态机
- 引入新依赖
- 改 schema / storage format

---

## 6. Final Notes

Codex 负责实现和自测。

OpenClaw 负责 review、功能验收、文档更新。

Human 负责最终批准是否 merge。
