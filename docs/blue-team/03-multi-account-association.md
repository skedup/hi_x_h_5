# 03 · 多账号关联图 / 出口 / 内容指纹 / AI 聚类

> 角度：平台如何把多个 UID 收成一个「同一控制器」连通分量。  
> 审计日期：2026-08-03 · 源码实证 · 忽略既有 `docs/blue/`。  
> Review： [关联 review](fded0b7d-f3b2-413b-b62c-310d03882ae0) `request-changes` → 本修订已吸收。

---

## 1. 核心判定

`CooccurrenceGuard` + 独立 profile + 串行抖动，能降低**最笨的同步刷**与**完全相同内容复读**。审计时默认配置下，平台仍可用：

**同 egress IP ∪ 同设备指纹 ∪ 同 note 短窗互动 ∪ 固定/近邻评论文本 ∪ 共享 xsecToken ∪ dedup 键空间分裂**

收成高置信关联分量。经 Wave A + D2 + C3/C8 后，**可代码缓解的边**已大体收口；**同机硬件指纹 / /24 / Gemini 双出口**仍在。

**运维抑制 ≠ 账号解关联。**

---

## 2. Detection Vectors

### P0

| ID | 向量 | 证据 | 状态 |
|----|------|------|------|
| P0-1 | 同机设备指纹坍缩 | 共用 Chrome；无硬件盐 | **residual（D4）**；环境侧 C3/C8 已接线 |
| P0-2 | 出口 IP 共享 / 代理无强制 | 曾可选、无互异 | **mitigated（A1）**；**/24 不做（D3）** |
| P0-3 | 工具 like/fav 无目标 dedup；explore 键分裂 | `interaction.ts` / `explore:like:` | **mitigated（A2）** |
| P0-4 | xsec 默认 `warn` | `config.ts` | **mitigated（A3）** 默认 `block` + explore bind |
| P0-5 | 固定「很棒的分享！」；评论键分裂 | `explore-ai.ts` | **mitigated（A4）**；近邻见 **D2** |
| P0-6 | Guard 仅进程内存 | Map/Set | **mitigated（A5）** 默认 persist |
| P0-7（增补） | `selectLikeTarget` 失败默认 `post` | `explore-ai.ts` | **mitigated（A4）** → `none` |
| P0-8（增补） | 浏览器 proxy、Node/Gemini 本机 | 双出口 | **residual**（配图 C4；Gemini 仍可能双出口） |

### P1

| ID | 向量 | 状态 |
|----|------|------|
| P1-1 | 默认 persona 同质（创建即写 `DEFAULT_*`） | 残余 |
| P1-2 | 评论仅精确 SHA256 | **mitigated（D2）** simhash；精确仍保留 |
| P1-3 | 媒体字节 SHA；title 不进键 | 残余（无 pHash） |
| P1-4 | explore 跨帖文本无正文去重 | **mitigated（A4）** `comment_text:` |
| P1-5 | `explored_notes` 按账号隔离 | 残余 |
| P1-6 | 30–120s 同动作波 | 残余 |
| P1-7 | 新号 QR + 同出口 | **todo（A7）** |
| P1-8 | explore feed 不 `bindXsecSource` | **mitigated（A3）** |
| P1-9 | QR → `api.qrserver.com` | 残余噪声 |

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
| C3 timezone/locale/geo | 异地代理与 Intl/languages 自洽 | 硬件指纹 |
| C8 WebRTC prefs | 代理下常见 ICE 宿主泄漏 | 全通道保证 |
| 串行 + 抖动 | ms 同步尖峰 | 分钟级波次 |
| 配额/熔断 | 单号频率 | 跨号同目标（靠 dedup） |
| 工具↔explore 统一 dedup + A5 persist | 同帖/同文案跨路径、跨重启 | 近邻以外的语义改写；硬件/IP |
| D2 评论 simhash | 微扰近邻文案 | 配图 pHash / embedding |
| xsec **默认 block** + explore bind | 跨账号复用 token | 关闭 `AD_XSEC` / mode=warn |
| A1 多账号互异 proxy | 同 server 共出口 | /24 共现（D3 未做）；单号默认可无 proxy |
| headless + liveness | 无人值守 | 同机硬件 |

---

## 4. 平台关联图模型

```text
边（权重示意）:
  同 egress_IP ──────────────── 强（A1 多号互异缓解；/24 未做）
  同设备指纹簇 ─────────────── 强（D4 residual）
  同 note 短窗 like ─────────── 强（A2+A5 已拦跨路径/跨重启）
  同 xsecToken ─────────────── 强（A3 默认 block）
  同/近邻评论文本 ───────────── 中强（A4+D2）
  双出口（browser vs Gemini）── 中（residual）
  30–120s 同动作波 ─────────── 中（残余）
```

---

## 5. 整改建议

### P0

1. **出口（A1）** — **done**；**/24 → D3 延后**。  
2. **键空间统一（A2）** — **done**。  
3. xsec block + explore bind（A3）— **done**。  
4. 去掉固定 fallback；评论键对齐（A4）— **done**。  
5. Guard 持久化（A5）— **done**。

### P1

6. 异质 persona 门禁 — 未做。  
7. 近邻去重 — **D2 done**（文本）；pHash/embedding 延期。  
8. 拒绝单次同 note 多账号写（A6）— **done**。  
9. 新号速率限制（A7）— **todo**。  
10. 浏览器外 fetch 旁路 — 配图 **C4 done**；Gemini residual。

---

## 6. 上线前关联图红线清单

- [x] 多账号写是否互异住宅/移动 proxy？（A1 代码门禁；运维仍须配真实互异出口）
- [x] 代理属地是否与 timezone/locale 一致（A1+C3；有 proxy 缺属地会 warn）
- [x] 工具 like 与 explore like 是否互斥（统一键）？
- [x] 同文案跨帖是否被 `comment_text:` 拦住？（近邻另见 D2）
- [x] xsec mode 是否 `block`？
- [x] AI 失败是否跳过评论且不默认赞帖？
- [x] 重启后 dedup/xsec 是否仍生效？
- [ ] 发布配图 / Gemini 是否造成双出口？（配图已对齐；**Gemini 仍可能双出口**）

---

## 7. 状态

| 项 | 状态 |
|----|------|
| 审计 | closed（可缓解 P0 mitigated；P0-1/P0-8 + A7/D3/D4 residual） |
| Wave A 整改 | **done**（A1–A6；A7 仍 todo） |
