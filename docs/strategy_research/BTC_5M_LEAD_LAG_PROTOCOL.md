# BTC 5 分钟 Up/Down 领先性研究协议

## 候选与冻结规则

候选固定为 `no_trade`、`volatility_baseline` 和 `external_lead_probability`。前 7 个完整自然日锁定所有特征、参数和阈值；后 7 日仅用于评估，禁止根据样本外结果改选模型或阈值。

## 两日 VPS 筛查边界

当前的 7 天 VPS 运行只验证公开数据管道、Chainlink 原始报告覆盖率、市场规则解析和成本数据可用性。它的结论只能是 `DATA_INSUFFICIENT` 或 `SCREEN_FAIL`；无论结果如何都不能产生 `ELIGIBLE_FOR_REVIEW`，更不能触发实盘。完整准入仍要求下述连续 14 天的训练与逐日样本外流程。

## 真值与特征

每个市场的结算基准来自 Polymarket RTDS 的 `crypto_prices_chainlink` 原始报告，并按市场规则明确声明的 TWAP 窗口计算。OKX 现货/永续的 1/3/10/30 秒收益、现货永续价差和盘口不平衡仅为领先性特征，不能替代 Chainlink 基准。

## 放行规则

`external_lead_probability` 必须在每个训练日和样本外日都呈现正向、时间对齐的外部特征到后续 Polymarket 变化关系；打乱对应关系的对照不得通过。还必须满足完整性、真实 bid/ask、动态费用和所有样本外收益条件。任何缺失或失败均为 `NO_GO`。
