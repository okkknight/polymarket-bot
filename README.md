# Polymarket Bot

Polymarket Bot 是一套围绕 Polymarket BTC 5 分钟 Up/Down 市场搭建的研究、执行和运行恢复系统。它的核心工作不是制造交易信号，而是把一个候选策略放到真实盘口、实际费用、数据质量和故障恢复面前，决定它有没有资格再往实盘走一步。

从只读采集开始，系统保留市场规则、Chainlink TWAP、真实 bid/ask、挂单量、费用和外部 BTC 行情；再用固定的训练与样本外时间切分做成本后回放。只有外部市场领先性和可成交的净优势都被验证，报告才有资格进入人工复核。回放、paper 和 shadow 把运行链路先跑出来，实盘执行、对账和恢复则留在后面的独立门里。

它是一套可审计的交易工程底座：每一份结论都有 run、原始数据和哈希可追，证据不够时就给出 `NO_GO`，而不是把缺失信息伪装成机会。

## 从只读模式开始

先装 Node.js 依赖，再读取少量公开市场数据：

```bash
npm ci
npm run pm:readonly:10
```

这一步不需要钱包密钥，也不会提交订单。访问市场数据需要本机网络可用；如需代理，按自己的环境设置 `HTTPS_PROXY`。其他只读入口见 `package.json` 中的 `pm:finder`、`pm:tracker` 和策略筛查命令。

想先看系统如何判断一次运行结果，可以执行离线验收脚本：

```bash
bash ops/scripts/run_verdict_center_v1_acceptance.sh
```

它使用固定样例检查结论生成和 Dashboard API，不会发送真实订单。

## 从研究走到执行

- **看市场：**采集数据，检查报价是不是够新、费用有没有吃掉空间、样本有没有意义，再产出可复核的报告。
- **先演一遍：**回放、paper 和 shadow 让信号和拟议订单先在不动真钱的环境里跑起来。
- **再碰实盘：**配置、账户身份、余额、持仓、订单和恢复状态都要过自己的门。
- **跑完对账：**把本地事件和交易所事实放在一起核对，结论写入 `data/run_verdict.json`。状态说不清时，系统宁可停下来。

架构细节在 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，当前运行状态以根目录 [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) 为准。负责运行器和门禁的脚本集中在 [`ops/scripts/`](ops/scripts/)。请先读 [`AGENTS.md`](AGENTS.md) 中的安全边界，再接触这些脚本。

## 实盘前

公开仓库来自清理过的源码快照，不带原私有仓库历史、真实钱包地址、密钥或运行数据。`.env.live.template` 只是配置说明；账户信息放在被 Git 忽略的 `.env.live.local`。

实盘路径会发送真实订单。开始前，把策略证据、账户状态、preflight 和人工批准都走完；README 里的只读示例只适合用来认识系统。

## 许可

代码采用 [MIT 许可证](LICENSE)。
