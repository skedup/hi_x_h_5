# 03 · 多账号关联图 / 出口 / 内容指纹 / AI 聚类

> 角度：平台如何把多个 UID 收成一个「同一控制器」连通分量。  
> 审计日期：2026-08-03 · 源码实证 · 忽略既有 `docs/blue/`。  
> Review： [关联 review](fded0b7d-f3b2-413b-b62c-310d03882ae0) `request-changes` → 本修订已吸收。

---

## 1. 核心判定

`CooccurrenceGuard` + 独立 profile + 串行抖动，能降低**最笨的同步刷**与**完全相同内容复读**，但在默认配置下，平台用：

**同 egress IP ∪ 同设备指纹 ∪ 同 note 短窗互动 ∪ 固定/近邻评论文本 ∪（可选）共享 xsecToken ∪ dedup 键空间分裂**

即可把多账号收成高置信关联分量。

**运维抑制 ≠ 账号解关联。**

---

## 2. Detection Vectors

### P0

| ID | 向量 | 证据 | 平台边 |
|----|------|------|--------|
| P0-1 | 同机设备指纹坍缩 | 共用 Chrome + `BROWSER_ARGS`；无 per-account UA/locale/timezone | 强：device_fp |
| P0-2 | 出口 IP 共享 / 代理无强制 | `proxy` 可选，仅 `{ server }`；无认证、无唯一性 | 强：同 IP |
| P0-3 | **MCP 工具路径** like/fav/like_comment **无**目标 `dedupKey` | `interaction.ts` 不传 dedupKey。**对比**：explore **已有** `explore:like:${id}` / `explore:like_comment:...` — 键空间与工具拟用 `like:note:` **不一致**，互不认 | 强：短窗共现；跨路径仍可刷 |
| P0-4 | xsec 默认 `warn` | `config.ts`；warn 只日志仍 allow | 强：同 token |
| P0-5 | AI/失败「很棒的分享！」；explore 评论键仅 note 维 | `explore-ai.ts`；`explore:comment:${noteId}`。工具评论用 `comment_text:${sha}` — 再次键分裂 | 中强：跨帖同文案 |
| P0-6 | Guard 仅进程内存 | Map/Set；重启清空 | 去重失效 |
| P0-7（增补） | AI `selectLikeTarget` 失败默认 `post` | `explore-ai.ts` | 抬高同帖共现密度 |
| P0-8（增补） | 浏览器走 proxy、Node `fetch`/Gemini 走本机 | 双出口 | 同 UID 双 IP |

### P1

| ID | 向量 | 证据 |
|----|------|------|
| P1-1 | 默认 persona 同质（创建即写 `DEFAULT_*`，无异质门禁） | `prompt-manager.ts` |
| P1-2 | 评论仅精确 SHA256 | 微扰绕过 |
| P1-3 | 媒体字节 SHA；title 不进键 | 重编码绕过 |
| P1-4 | explore 跨帖文本无正文去重 | `explore:comment:${noteId}` |
| P1-5 | `explored_notes` 按账号隔离 | 热帖多号共现 |
| P1-6 | 30–120s 同动作波 | 串行冷却后仍相关 |
| P1-7 | 新号 QR + 同出口 | 登录图簇 |
| P1-8 | explore feed 不 `bindXsecSource` | 归属靠「谁先写」 |
| P1-9 | QR → `api.qrserver.com` | 噪声 |

### P2

| ID | 向量 | 说明 |
|----|------|------|
| P2-1 | 同模型 + 10–30 字短评 | 风格聚类 |
| P2-2 | like-target 70/20/10 | 分布可聚类 |
| P2-3 | `XHS_MCP_AD_COOCCURRENCE=false` 可回退并行 | `sequential` 写死无独立 env |
| P2-4 | 单账号冷却默认 5s | 连发偏密 |
| P2-5 | 无 stealth 脚本 | 依赖 patchright |

---

## 3. 已有能力边界（必须分清）

| 能力 | 防什么 | 不防什么 |
|------|--------|----------|
| 独立 `profileId` | Cookie/存储串号 | 硬件指纹 / IP |
| C2.1 串行 + 抖动 | ms 同步尖峰 | 分钟级波次 |
| C2.3 配额/熔断 | 单号频率 | 多号同目标（工具路径） |
| C2.4 工具路径评论/媒体精确 SHA | 完全相同正文/字节 | 近邻；explore 键空间 |
| explore 同 note 去重（`explore:like:*`） | 同进程多号刷同一帖（仅 explore） | 工具路径 like；跨帖同文案；重启后失效 |
| xsec block 模式 | 跨账号复用 | **默认 warn** |
| headless + liveness | 无人值守 | 同机硬件 |

---

## 4. 平台关联图模型

```text
边（权重示意）:
  同 egress_IP ──────────────── 强
  同设备指纹簇 ─────────────── 强
  同 note 短窗 like（工具无 dedup）─ 强
  工具 like ↔ explore like 键分裂 ─ 强（整改后应消失）
  同 xsecToken（warn）──────── 强
  同评论文本 / 固定 fallback ── 中强
  双出口（browser vs Node）─── 中
  30–120s 同动作波 ─────────── 中
```

---

## 5. 整改建议

### P0

1. **出口**：`accounts.length>1` / `all` 强制互异认证 proxy；单账号策略见 plan A1。**砍掉无实现的「同 /24」**，或单列 P1 并写 DNS→IP→/24 DoD。迁移期可 `warn`。
2. **键空间统一（硬要求）**：工具与 explore 共用 `like:note:` / `fav:note:` / `like_c:` / `comment_text:`（可弃用 `explore:` 前缀）；跨路径单测。
3. xsec 默认 `block`；explore `getFeeds` 后 `bindXsecSource`。
4. 去掉固定 fallback；`selectLikeTarget` 失败 → `none`；explore 评论提交 `comment_text:${sha}`（可双键）。
5. Guard 持久化：**A2+A3+A4 键冻结后再做**，避免旧键死数据。

### P1

6. 异质 persona 门禁。  
7. 近邻去重 / pHash — **D2 文本近邻 mitigated**（simhash；见 [D2-NEAR-DEDUP.md](./D2-NEAR-DEDUP.md)）；配图 pHash / embedding **延期**。  
8. 拒绝单次调用同 note 多账号写。  
9. 新号速率限制。  
10. 浏览器外 `fetch` 旁路纳入关联审计（与 C4 对齐）。

---

## 6. 上线前关联图红线清单

- [ ] 多账号写是否互异住宅/移动 proxy？
- [ ] 代理属地是否与 timezone/locale 一致（A1+C3）？
- [ ] 工具 like 与 explore like 是否互斥（统一键）？
- [ ] 同文案跨帖是否被 `comment_text:` 拦住？
- [ ] xsec mode 是否 `block`？
- [ ] AI 失败是否跳过评论且不默认赞帖？
- [ ] 重启后 dedup/xsec 是否仍生效？
- [ ] 发布配图 / Gemini 是否造成双出口？

---

## 7. 状态

| 项 | 状态 |
|----|------|
| 审计 | open（review 修订已合入文档） |
| Wave A 整改 | pending |
