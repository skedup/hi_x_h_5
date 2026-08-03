# 03 · 多账号关联图 / 出口 / 内容指纹 / AI 聚类

> 角度：平台如何把多个 UID 收成一个「同一控制器」连通分量。  
> 审计日期：2026-08-03 · 源码实证 · 忽略既有 `docs/blue/`。

---

## 1. 核心判定

`CooccurrenceGuard` + 独立 profile + 串行抖动，能降低**最笨的同步刷**与**完全相同内容复读**，但在默认配置下，平台用：

**同 egress IP ∪ 同设备指纹 ∪ 同 note 短窗互动 ∪ 固定/近邻评论文本 ∪（可选）共享 xsecToken**

即可把多账号收成高置信关联分量。

**运维抑制 ≠ 账号解关联。**

---

## 2. Detection Vectors

### P0

| ID | 向量 | 证据 | 平台边 |
|----|------|------|--------|
| P0-1 | 同机设备指纹坍缩 | 共用 Chrome channel + `BROWSER_ARGS`；无 per-account UA/locale/timezone/WebGL 盐（`context.ts:28-36`） | 强：device_fp 簇 |
| P0-2 | 出口 IP 共享 / 代理无强制 | `proxy` 可选字符串，仅 `{ server }`，无认证、无唯一性校验 | 强：同 IP |
| P0-3 | 同 note 多账号 like/fav 无目标去重 | `xhs_like_feed` 等支持 `accounts`/`all` 但不传 `dedupKey` | 强：短窗共现 |
| P0-4 | xsecToken 默认 `warn`（放行） | `config.ts:155-159`；warn 路径只日志仍 allow | 强：同 token 多 UID |
| P0-5 | AI/失败默认「很棒的分享！」 | `explore-ai.ts:197-201`；explore 去重按 `noteId` 不按正文 | 中强：跨帖同文案 |
| P0-6 | Guard 仅进程内存 | Map/Set 单例；重启清空（`antidetect.ts`） | 去重/绑定失效 |

### P1

| ID | 向量 | 证据 |
|----|------|------|
| P1-1 | 默认 persona/prompt 同质 | 新账号写入相同 `DEFAULT_*`（`prompt-manager.ts` / `defaults.ts`） |
| P1-2 | 评论仅精确 SHA256 | 改标点/同义即绕过（`interaction.ts`） |
| P1-3 | 媒体仅文件字节 SHA；title 不进键 | 重编码/改 EXIF 绕过；同图不同文案可过 |
| P1-4 | explore 跨帖文本无去重 | `explore:comment:${noteId}` |
| P1-5 | `explored_notes` 按账号隔离 | 热帖上多账号仍可共现 |
| P1-6 | 串行后仍呈 30–120s 同动作波 | `interAccountCooldownMs` |
| P1-7 | 新号 QR 爆发 + 同出口 | 临时 profile + 可选同一 proxy |
| P1-8 | explore feed 不 `bindXsecSource` | search/list_feeds 会 bind；explore 只在写路径带 token |
| P1-9 | QR 图走第三方 `api.qrserver.com` | 运营噪声 |

### P2

| ID | 向量 | 说明 |
|----|------|------|
| P2-1 | 同 Gemini 模型 + 短评 10–30 字约束 | 风格可统计聚类 |
| P2-2 | like-target 写死 70%/20%/10% | 点赞目标分布可聚类 |
| P2-3 | 可 env 关闭 cooccurrence 回退并行 | 配置踩坑 |
| P2-4 | 单账号动作后冷却默认仅 5s | 连发仍偏密 |
| P2-5 | 无 stealth 脚本（与旧文档预期不符） | 依赖 patchright + args |

---

## 3. 已有能力边界（必须分清）

| 能力 | 防什么 | 不防什么 |
|------|--------|----------|
| 独立 `profileId` 硬不变量 | Cookie/存储串号 | 硬件指纹 / IP |
| C2.1 串行 + 账号间抖动 | ms 级同步尖峰 | 分钟级波次相关 |
| C2.3 配额 / 冷却 / 熔断 | 单号频率与风控扩散 | 多号同目标共现 |
| C2.4 精确 SHA 去重（工具路径评论/发布媒体） | 完全相同正文/字节 | 近邻改写 / 重编码 |
| explore 同 note 去重（进程内） | 同进程多号刷同一帖 | 跨帖同文案；重启后失效 |
| xsec 绑定（block 模式） | 跨账号复用 token | **默认 warn 削弱实战价值** |
| headless 写门禁 + liveness | 无人值守/无头写 | 同机多号仍同硬件 |

---

## 4. 平台关联图模型（本代码会自然产生的边）

```text
节点: UID / device_fingerprint / egress_IP / content_hash / xsec_token

边（权重示意）:
  同 egress_IP ──────────────── 强（无 proxy 时必然）
  同设备指纹簇 ─────────────── 强（同机 Chrome）
  同 note 短窗 like/fav ─────── 强（无目标 dedup）
  同 xsecToken 多 UID 写 ────── 强（默认 warn）
  同评论文本（含固定 fallback）─ 中强
  同媒体字节哈希发布 ───────── 中（有精确 dedup 可降）
  30–120s 间隔同动作波 ─────── 中
  同默认 persona AI 风格 ───── 弱–中
  同时段同 IP 多 QR 登录 ───── 中
```

**典型连通分量构造：**

1. **基础设施层**：`IP ∪ device_fp` 先收成一团。  
2. **行为共现层**：`accounts:all` like 同一 `noteId` 加稠密边。  
3. **内容层**：fallback / 未改 prompt 的 AI 短评跨 note 连边。  
4. **会话层**：warn 下共享 xsec 焊接「谁搜的 / 谁点的」。  
5. **时序层**：串行冷却后的波次仍可用互相关检出同一控制器。

---

## 5. 整改建议

### P0

1. **出口硬约束**：写操作要求 `proxy` 非空；支持 `username/password`；禁止多账号共享同一 `server`（或同 /24）；无 proxy 拒绝 `accounts.length > 1` 的写。
2. **目标共现去重**：`like:note:${id}` / `fav:note:${id}` / `like_c:${noteId}:${commentId}` 跨账号硬拦。
3. **xsec 生产默认 `block`**；explore `getFeeds` 后 `bindXsecSource`。
4. **去掉固定 fallback「很棒的分享！」**：失败跳过；explore 评论键改为正文 SHA（或双键 note+text）。
5. **Guard 持久化**：dedupCommitted / tokenOwner 落 SQLite。

### P1

6. 强制异质 persona（创建时相似度门禁，或强制 `xhs_set_account_prompt`）。
7. 评论归一化 + 可选 embedding 近邻；媒体 pHash。
8. 发布 dedup 纳入 title；可选「仅媒体哈希」跨账号拦截。
9. 拉长跨账号间隔至小时级随机；API 层拒绝单次调用对同一 `noteId` 多账号写。
10. 新号速率限制：同 proxy/同主机下 QR 日上限；新号冷却期禁互动写。

### P2

11. like-target 比例账号级可配置随机。  
12. 文档标明：反关联依赖运营配置 proxy/persona，而非 stealth 脚本。  
13. 本地审计：同 note 多账号动作、同评论文本、同媒体哈希、同 egress——上线前自检。

---

## 6. 上线前关联图红线清单

- [ ] 所有写账号是否配置了**互不相同**的住宅/移动代理？
- [ ] 代理属地是否与账号 `timezoneId`/`locale` 一致？
- [ ] 是否禁止对同一 `noteId` 用 `accounts:all` 点赞/收藏？
- [ ] `XHS_MCP_AD_XSEC_MODE` 是否为 `block`？
- [ ] 各账号 persona/select/comment prompt 是否足够异质？
- [ ] Gemini 失败时是否会跳过评论（而非发固定句）？
- [ ] 进程重启后跨账号 dedup 是否仍生效（需持久化后勾选）？
- [ ] 过去 24h 本地审计：同 IP 多 UID、同文案、同媒体哈希是否为零？

---

## 7. 状态

| 项 | 状态 |
|----|------|
| 审计 | open |
| Wave A 整改 | pending |
