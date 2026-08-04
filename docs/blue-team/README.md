# 蓝军分析（2026-08 独立审计）

> **性质**：从零静态审计，不依赖 `docs/blue/` 既有报告。  
> **目标**：识别小红书侧可能用来判定「AI / 自动化农场」的信号，并给出整改优先级。  
> **方法**：三个独立角度并行分析后交叉合成；经三路独立 review 修订（见文末）。

| 文档 | 角度 | 分析子代理 | 文档 review |
|------|------|------------|-------------|
| [01-fingerprint-environment.md](./01-fingerprint-environment.md) | 浏览器 / 设备指纹 / CDP / 环境一致性 | [指纹面](d572560e-4fe8-4769-861c-0bb0ef82e69d) | [指纹 review](1600ce01-1923-47b5-a075-6f4f0114d87c) |
| [02-behavior-authenticity.md](./02-behavior-authenticity.md) | 键鼠轨迹 / 延迟分布 / 导航会话 / Explore | [行为面](54d8298e-07df-4ae8-bc86-c82c5a51874d) | [行为 review](0311295f-d10a-4c72-ad56-df51121c63fa) |
| [03-multi-account-association.md](./03-multi-account-association.md) | 多账号关联图 / 出口 / 内容指纹 / AI 聚类 | [关联面](9c6198b1-2c72-44d0-8c16-632eb28060ef) | [关联 review](fded0b7d-f3b2-413b-b62c-310d03882ae0) |

---

## 一句话总判

**2026-08-04 收口**：A/B/C 与 D1/D2 代码项已合入 develop（见 [IMPLEMENTATION-PLAN §6](./IMPLEMENTATION-PLAN.md)）。底座 + 会话化互动 + 统一 dedup/xsec/persist + 属地/WebRTC 缓解了审计时的「默认裸奔」行为与关联面。  
**仍未解**：同机硬件指纹共现（D4）、同 /24（D3）、A7 登录速率、IME composition（wontfix）、Gemini 双出口。运维门禁仍 ≠ 设备解关联。

---

## 跨角度 P0 红线（审计当时 → 现状）

| # | 红线 | 所属面 | 现状 |
|---|------|--------|------|
| 1 | 同机硬件指纹；proxy 与时区/locale；WebRTC 泄真实 IP | 指纹 + 关联 | 硬件 **residual（D4）**；C3/C8 **mitigated**；A1 多号互异 proxy |
| 2 | Interact 直链一点即关；均匀延迟；无 IME | 行为 | B1–B3 **mitigated**；IME **wontfix**；有机点入 D1 可选 |
| 3 | 工具无 dedup / 键分裂；xsec warn；固定评论；Guard 内存 | 关联 | A2–A5 **mitigated**；D2 近邻 |
| 4 | `HEADLESS=true` 登录固定 viewport | 指纹 | C2 **mitigated**（默认强制 headful） |
| 5 | Explore 硬跳过全部视频 | 行为 | B4 **mitigated** |

---

## 整改路线图（波次状态）

### Wave A — 关联与出口 — **done**（A7 仍 todo）

1. 多账号写强制互异认证 proxy — **done（A1）**。
2. 统一 dedup 键空间 — **done（A2）**。
3. xsec 默认 `block` + explore bind — **done（A3）**。
4. 去掉固定 fallback；评论键对齐 — **done（A4）**。
5. Guard 持久化 — **done（A5）**。

### Wave B — 行为真实性 — **done**（B5 Phase2 wontfix）

1. Interact 会话化 — **done（B3）**；有机点入 **[D1](./D1-FEED-ENTRY.md)**。
2. 轨迹点击 — **done（B2）**。
3. `heavyTailDelay` — **done（B1）**。
4. Explore 滚动/视频/revise — **done（B4/B6）**。
5. IME Phase2 — **wontfix**（[B5-IME.md](./B5-IME.md)）。
6. B7 导航/alreadyDone — **done**。

### Wave C — 指纹与环境 — **done**

1. `BROWSER_ARGS` — **done（C1）**。
2. 登录 headful — **done（C2）**。
3. timezone/locale/geo — **done（C3）**。
4. 配图对齐 — **done（C4）**。
5. 登出归档 — **done（C5）**。
6. WebRTC + CLAUDE — **done（C8/C7）**；evaluate 世界 **C6**。

### Wave D

| ID | 状态 |
|----|------|
| D1 feed 点入 | **done** |
| D2 评论近邻 | **done**（无 pHash） |
| D3 /24 | 延后 |
| D4 硬件隔离 | 延后 |
---

## 运维门禁 vs 反检测（勿混淆）

| 机制 | 作用 | 是否改变平台可见行为指纹 |
|------|------|--------------------------|
| `CooccurrenceGuard` 串行/配额/熔断 | 降同步尖峰、控频率 | 部分（时序仍有 30–120s 波次） |
| `liveness` 息屏停写 | 无人值守自保 | 否 |
| `headlessWriteGate` | 强制 headful 写 | 间接（避免 headless 组合异常） |
| 独立 `profileId` | Cookie/存储隔离 | **不**隔离硬件指纹（代码注释「设备指纹盐」仅指 profile 内持久化标识） |

---

## 实施计划

按波次落地的可执行 backlog（含 DoD、触及文件、回滚开关、PR 切片）见：

→ **[IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md)**  
→ A1 迁移：[A1-PROXY-RUNBOOK.md](./A1-PROXY-RUNBOOK.md)  
→ D1/D2：[D1-FEED-ENTRY.md](./D1-FEED-ENTRY.md) · [D2-NEAR-DEDUP.md](./D2-NEAR-DEDUP.md)  
→ C3/C8：[C3-LOCALE-ENV.md](./C3-LOCALE-ENV.md) · [C8-WEBRTC.md](./C8-WEBRTC.md)

顺序：Wave A/B/C 与 D1/D2 **已合入**；扩大 `accounts:all` / 异地代理多账号写前仍须：互异 proxy、账号 `timezoneId`/`locale`、过一遍 [03 §6 红线](./03-multi-account-association.md) 与 [plan §6](./IMPLEMENTATION-PLAN.md)。

---

## 文档维护

- 本目录为 **2026-08 独立审计** 基线；整改状态见各册 §状态与 plan §6（**2026-08-04 验收收口**）。
- 不覆盖、不引用 `docs/blue/01–08` 旧报告结论；若历史结论与本文冲突，以本文源码证据为准。
- **2026-08-03**：三路 review 均为 `request-changes`，已吸收进本文档与 plan。
- **2026-08-04**：§6 代码 DoD 勾选 + 01/02/03 P0 mitigated 标注；残余 D3/D4/A7/IME/Gemini。
