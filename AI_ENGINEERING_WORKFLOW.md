# AI_ENGINEERING_WORKFLOW.md

本文件定义本项目的极简 AI-native engineering workflow。

适用角色：
- Human（你）
- Codex
- OpenClaw

---

## 1. Workflow Goal

目标：
- 保持开发流程简单
- 让 Codex 专注实现
- 让 OpenClaw 独立 review + 验收
- 让项目文档持续更新
- 降低上下文漂移与工程混乱

本项目不采用复杂多分支、多目录迁移流程。

---

## 2. Roles

### 2.1 Human
角色：Planner / Final Approver

负责：
- 定义任务
- 写 task spec
- 判断是否批准高风险改动
- 最终决定是否 merge

### 2.2 Codex
角色：Coder / Self-Validator

负责：
- 阅读 task spec
- 阅读相关代码
- 实现代码改动
- 运行基础验证
- 提交 PR

Codex 不负责：
- 最终功能验收
- 最终项目文档裁定

### 2.3 OpenClaw
角色：Reviewer / Functional Validator / Doc Maintainer

负责：
- review Codex 改动
- 做功能验收
- 检查是否符合 task spec
- 更新项目长期文档

OpenClaw 不负责：
- 在 review 阶段做大范围重构
- 擅自扩大任务范围

---

## 3. Branch Strategy

仅使用两种分支：

- `main`
- `task/*`

规则：
- `main` 始终保持相对稳定
- 每个任务创建一个 `task/*` 分支
- 1 task = 1 branch = 1 PR
- review 打回后，在同一个 task 分支继续修复
- 通过后 merge 到 `main`

示例：

```text
main
task/recovery-convergence
task/order-ledger-fix
```

---

## 4. Repo Structure

推荐最小结构：

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

说明：
- `tasks/`：任务说明（AAEC-E）
- `docs/PROJECT_CONTEXT.md`：项目总览（阶段/优先级/风险）
- `docs/ARCHITECTURE.md`：架构事实源（As-Is/To-Be/Gap）
- `docs/CHANGELOG.md`：中大型变更记录（改动/影响/验证）
- `docs/ENGINEERING_LOG.md`：工程决策与问题复盘（why/tradeoff）
- review 历史默认使用 GitHub PR，不额外强制维护 review 文件

---

## 5. Standard Task Loop

每个任务都走下面这个流程：

### Step 1 — Human 创建任务
Human 在 `tasks/` 下创建 task spec：

```text
tasks/TASK_YYYYMMDD_<short_name>.md
```

推荐使用 AAEC-E 模板。

### Step 2 — Codex 实现
Codex：
- 阅读 task spec
- 阅读相关文件
- 在 `task/*` 分支上实现
- 运行可行的验证
- push 并创建 PR

### Step 3 — OpenClaw Review
OpenClaw 查看：
- task spec
- PR diff
- validation result
- CI result（如果有）

然后输出：
- review verdict
- acceptance verdict
- required fixes（如果有）

### Step 4 — 如果打回
如果 OpenClaw 不通过：
- Codex 在同一个 `task/*` 分支继续修复
- 再次 push
- OpenClaw 继续 review

### Step 5 — 如果通过
如果 OpenClaw review + acceptance 通过：
- OpenClaw 按需更新 `docs/PROJECT_CONTEXT.md`
- OpenClaw 按需更新 `docs/ARCHITECTURE.md`
- OpenClaw 按需更新 `docs/CHANGELOG.md`
- OpenClaw 按需更新 `docs/ENGINEERING_LOG.md`
- Human 最终查看 PR 并决定 merge

---

## 6. Validation Model

### 6.1 Codex Self-Validation
Codex 负责技术自检，例如：
- unit test
- lint
- build
- basic smoke verification

### 6.2 OpenClaw Functional Acceptance
OpenClaw 负责：
- 是否满足任务目标
- 是否满足 acceptance criteria
- 是否引入明显回归风险
- 是否存在未说明假设

两者不能混为一谈。

---

## 7. Definition of Done

一个任务只有在下面条件满足时才算完成：

- task spec 已定义
- Codex 实现完成
- Codex 已做 self-validation，或明确说明未执行项
- OpenClaw review 完成
- OpenClaw functional acceptance 完成
- 相关 docs 已更新（若任务影响项目状态或决策）
- Human 最终批准 merge

---

## 8. What Goes Where

### 放在 `tasks/`
- 任务 spec

### 放在 PR 里
- implementation summary
- code review comments
- request changes
- acceptance discussion

### 放在 `docs/PROJECT_CONTEXT.md`
- 当前项目阶段
- 当前优先级
- 当前已知风险

### 放在 `docs/ARCHITECTURE.md`
- As-Is / To-Be 架构变化
- 核心运行契约变化（例如结果口径、状态机）

### 放在 `docs/CHANGELOG.md`
- 中大型迭代的改动、原因、影响、验证

### 放在 `docs/ENGINEERING_LOG.md`
- 重要决策
- 失败尝试
- 工程 tradeoff
- 值得保留的经验

---

## 9. Simplicity Rule

当流程复杂度和收益不匹配时，优先选择更简单的方式。

本项目默认：
- 不引入额外 agent 分支
- 不强制维护 review 文件体系
- 不做复杂 archive 目录移动
- 尽量用 GitHub PR 承载 review 历史

---

## 10. Short Version

这个项目的最小工作流是：

```text
Human 写任务
→ Codex 实现并开 PR
→ OpenClaw review + 验收
→ OpenClaw 更新 docs
→ Human merge
```

就这样，不再额外复杂化。
