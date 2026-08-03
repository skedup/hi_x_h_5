# D2 · 评论文本近邻去重（simhash）

**状态**：done（`feat/blue-d1-d2`）

## 决策

- **仅评论文本近邻**（归一化 + 64-bit simhash）；**不做**配图 pHash / embedding API（延期）
- 精确键 `comment_text:` / `reply_text:` + SHA-256 **保留**；近邻为额外门禁
- 策略与 A4 一致：跨账号拦截（`cross_account_dedup`）；同账号放行

## 算法

1. **归一化**：NFKC、小写、去空白/常见标点、全半角折叠
2. **指纹**：字符 bigram → 64-bit simhash（本地，无新依赖）
3. **判定**：与已提交/进行中指纹 Hamming ≤ `threshold`（默认 3）→ 拦截

## 配置

| 变量 | 默认 | 说明 |
|------|------|------|
| `XHS_MCP_AD_NEAR_DEDUP` | `true` | 关闭近邻门禁 |
| `XHS_MCP_AD_NEAR_DEDUP_THRESHOLD` | `3` | Hamming 阈值 |
| `XHS_MCP_AD_PERSIST` | （A5） | 开启时近邻指纹落库 `ad_dedup_near`，TTL/GC 同 A5 |

## 接入

- `BeforeActionInput.nearText` → `CooccurrenceGuard`
- `tools/interaction.ts` 评论/回复传 `nearText: content`
- explore 发评路径同样传入原文
- 模块：`src/core/near-text.ts`

## 验证

```bash
bun test src/core/near-text.test.ts src/core/antidetect.test.ts
```

## DoD

- [x] 同文案精确 SHA 仍拦（A4 回归）
- [x] 「今天天气真好」vs「今天天气真好！」等近邻跨账号被拦
- [x] 明显不同文案不拦
- [x] 单测覆盖归一化 / Hamming / guard
- [x] 文档写明图片 pHash 延期

## 刻意不做

- 配图 pHash / embedding 模型（2B）
