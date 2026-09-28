# Polymarket AI Workflow 使用说明

本说明文档解释如何在你的 Polymarket 项目里使用下面这些文件：

- `AGENTS.md`
- `AI_ENGINEERING_WORKFLOW.md`
- `AAEC-E_TASK_TEMPLATE.md`

适用模式：
- GitHub + 本地混合模式
- Codex 负责实现
- OpenClaw 负责 review + 验收 + 文档更新

---

## 1. 先把这些文件放到哪里

推荐直接放到 repo 中：

```text
repo/
├─ AGENTS.md
├─ AI_ENGINEERING_WORKFLOW.md
├─ README.md
├─ docs/
│  ├─ PROJECT_CONTEXT.md
│  ├─ ARCHITECTURE.md
│  ├─ CHANGELOG.md
│  └─ ENGINEERING_LOG.md
├─ tasks/
├─ src/
└─ tests/
```

如果 `docs/PROJECT_CONTEXT.md` / `docs/ARCHITECTURE.md` / `docs/CHANGELOG.md` / `docs/ENGINEERING_LOG.md` 还没有，可以先创建空文件。

---

## 2. 一次任务怎么开始

### 2.1 Human 创建任务
从模板复制一份：

```text
AAEC-E_TASK_TEMPLATE.md
```

另存为：

```text
tasks/TASK_YYYYMMDD_<short_name>.md
```

例如：

```text
tasks/TASK_20260311_recovery_convergence.md
```

然后把本次任务补充完整。

---

## 3. 怎么交给 Codex

你可以对 Codex 说：

```text
Please implement the task defined in:

tasks/TASK_20260311_recovery_convergence.md

Follow AGENTS.md and AI_ENGINEERING_WORKFLOW.md.
Only perform the Codex-assigned part.
```

Codex 的职责是：
- 读 task spec
- 读相关代码
- 在 task 分支实现
- 自测
- 开 PR

---

## 4. 分支怎么开

使用极简规则：

```text
main
task/*
```

例如：

```bash
git checkout main
git pull
git checkout -b task/recovery-convergence
```

然后让 Codex 在这个分支工作。

---

## 5. Codex 完成后应该输出什么

Codex 至少应在 PR 描述或回复中给出：

- Summary
- Files Changed
- Validation Run
- Risks / Limitations

示例：

```text
Summary:
Implemented bounded convergence reconciliation for unconfirmed recovered holdings.

Files Changed:
- apps/polymarket-bot/recovery_engine.mjs
- apps/polymarket-bot/tests/recovery.test.mjs

Validation Run:
- npm test ✅
- npm run lint ✅
- npm run build ✅

Risks / Limitations:
- assumes convergence within configured reconciliation window
```

---

## 6. 怎么交给 OpenClaw

你可以对 OpenClaw 说：

```text
Please review and perform functional acceptance for this PR.
Use:
- tasks/TASK_20260311_recovery_convergence.md
- AGENTS.md
- AI_ENGINEERING_WORKFLOW.md

Check both review quality and task acceptance.
Update project docs if needed.
```

OpenClaw 应查看：
- task spec
- PR diff
- validation result
- CI result（如果有）

---

## 7. 如果 OpenClaw 打回怎么办

流程非常简单：

1. OpenClaw 在 PR 中指出问题
2. Codex 在同一个 `task/*` 分支修复
3. Codex 再次 push
4. OpenClaw 再 review
5. 直到通过

不要新开额外分支。
不要额外发明复杂 review 文档体系。
直接让 GitHub PR 承载 review 历史。

---

## 8. 什么情况下更新 docs

### 更新 `docs/PROJECT_CONTEXT.md`
当下面这些发生时：
- 项目阶段变化
- 当前优先级变化
- 已知风险变化
- 当前系统状态变化

### 更新 `docs/ARCHITECTURE.md`
当下面这些发生时：
- As-Is / To-Be 架构边界发生变化
- 关键状态机/运行契约变化

### 更新 `docs/CHANGELOG.md`
当下面这些发生时：
- 中大型迭代落地
- 需要沉淀“改动/原因/影响/验证”

### 更新 `docs/ENGINEERING_LOG.md`
当下面这些发生时：
- 做了重要设计决策
- 遇到了关键 bug
- 接受了某个 tradeoff
- 某个失败尝试值得以后参考

通常由 OpenClaw 在 PR 通过前顺手更新。

---

## 9. 什么时候 merge

只有在下面条件满足时才 merge：

- Codex 已实现
- Codex 已自测或明确说明未执行项
- OpenClaw review 通过
- OpenClaw functional acceptance 通过或明确说明剩余未验证项
- 需要更新的 docs 已更新
- Human 最终确认接受

---

## 10. 推荐的最小日常操作法

你可以每天都按这个最小循环走：

### Human
1. 明确一个小任务
2. 新建 `tasks/TASK_xxx.md`
3. 开 `task/*` 分支
4. 交给 Codex

### Codex
1. 实现
2. 自测
3. push
4. 开 PR

### OpenClaw
1. review
2. 验收
3. 更新 docs

### Human
1. 看 PR
2. merge

---

## 11. 最重要的原则

如果你发现流程又开始复杂化，请回到下面这条：

```text
任务说明放 tasks/
长期知识放 docs/
review 历史放 PR
分支只用 main + task/*
```

这样最稳。

---

## 12. 快速复制版

```text
1. 从模板创建 tasks/TASK_xxx.md
2. 开 task/* 分支
3. Codex 实现 + 自测 + 开 PR
4. OpenClaw review + 验收 + 更新 docs
5. Human merge
```

这就是本项目的极简 AI workflow。
