## Patchright / Chrome 运行时指纹专项报告

### 1. 结论摘要

项目使用 Patchright 1.57.0 + Google Chrome 150 的常见 Playwright 静态痕迹已经得到有效修补：

- `navigator.webdriver` 实测为 `false`
- 未发现 `playwright`、`__pw`、`puppeteer`、`selenium` 等主世界全局变量
- `Error.stack` getter 未被 console/CDP 读取
- 普通站点脚本的 Error stack 未出现框架标识
- UA-CH、plugins、mimeTypes、WebGL 和 `window.chrome` 未发现明确的单点异常
- Patchright locator 产生的点击事件 `isTrusted=true`

但 Patchright 不能掩盖项目自身制造的运行时异常。当前最明确的风险是：

1. headless 模式直接暴露 `HeadlessChrome` UA。
2. 项目固定 1920×1080 viewport，使 headful/headless 均出现 `screen == viewport`，并且 DPR 固定为 1；这与 Patchright 自身推荐的 `viewport: null` 相冲突。
3. 项目多处 `el.click()`、`dispatchEvent()` 产生 `isTrusted=false`，已通过本地实验证实。这是比 Patchright 框架指纹更直接、更可靠的行为侧信号。
4. Patchright 仍通过 CDP pipe、isolated world、`Runtime.evaluate`、`Target.setAutoAttach` 等机制工作，只是修补了已知泄漏；不能推导为“对所有平台检测不可见”。
5. 项目叠加禁用后台调度、渲染和权限提示等参数，可能形成可观测的页面生命周期或权限行为组合，但本轮证据不足以认定为稳定检测信号。

整体判断：**Patchright 降低了基础 Playwright 指纹风险，但没有改变原报告关于客户端行为可被识别的核心结论。平台更可能从合成事件、headless 配置、固定显示环境及跨会话行为关联识别自动化，而不是依赖单独的 `navigator.webdriver`。**

---

### 2. 实验边界与安全措施

- Patchright：`1.57.0`
- Google Chrome：`150.0.7871.115`
- 实际项目配置：
  - `channel: "chrome"`
  - persistent context
  - 默认 `headless: false`
  - viewport 1920×1080
  - 项目 13 个自定义启动参数
- 仅使用隔离 profile：
  - `/private/tmp/xhs-profile-patchright.gOESfw`
- 未启动、写入或修改真实 profile：
  - `/Users/skedushwang/.openclaw/workspace/kindred/life/state/xiaohongshu/browser-profile/`
- 页面仅使用：
  - `data:` URL
  - `127.0.0.1` 临时 HTTP 页面
- 附加网络隔离：
  - DNS sinkhole
  - data URL 测试中设置 offline
  - 路由全部阻断
  - local HTTP 测试中仅允许 loopback
  - service workers 禁用
- 最终 headless data URL 测试观测网络请求数为 0。
- 最终 headful local HTTP 测试仅观测到 1 个 loopback 请求。
- 未访问 `xiaohongshu.com` 或其他外网。
- 未输出 Cookie、Token、账号标识、完整 UA/WebGL 字符串或完整高熵指纹。

---

### 3. 实测结果

| 检查项 | Headful、本地 HTTP | Headless、data URL | 判断 |
|---|---|---|---|
| `navigator.webdriver` | `false` | `false` | Patchright 修补有效 |
| `webdriver` 属性 | 原型属性存在，native-like getter | 同左 | 与普通 Chrome 形态相符 |
| UA 含 `HeadlessChrome` | 否 | 是 | headless 明确暴露 |
| UA-CH | 3 个正常 Chrome 品牌项、macOS、非移动 | data URL 下不可用 | headful 未见异常；data URL 结果不能外推到平台 |
| `window.chrome` | 存在 | 存在 | 未见缺失 |
| `window.chrome.runtime` | 不存在 | 不存在 | 单点证据弱，普通无扩展页面也可如此 |
| plugins | 5 | 5 | 未见空插件数组 |
| MIME types | 2 | 2 | 未见空数组 |
| PDF viewer | 存在 | 存在 | 未见异常 |
| languages | 2 个，首项与 `language` 一致 | 同左 | 内部一致 |
| 权限查询 | local HTTP 均为 `prompt` | data URL 均为 `denied` | 明显受 origin 影响，不能作为自动化结论 |
| viewport | 精确等于配置的 1920×1080 | 同左 | 固定配置被准确反映 |
| screen 与 viewport | 相等 | 相等 | 组合异常风险 |
| outer 与 inner | 高度小幅不同 | 完全相等 | headless 更明显 |
| DPR | 1 | 1 | 在 macOS 上不是不可能，但与其他固定值组合后风险升高 |
| 色深 | 30 | 24 | headful/headless 存在模式差异 |
| WebGL | Apple + ANGLE，非软件渲染 | 同左 | 未见 SwiftShader/llvmpipe |
| 可疑 window 全局名 | 0 | 0 | Patchright 主世界清理有效 |
| 页面可见性 | visible、focused | visible、focused | 当前前台页正常 |
| rAF 中位区间 | 6–12 ms | 6–12 ms | 未见明显异常 |
| 零延时 timer 中位区间 | 4–6 ms | 4–6 ms | 当前前台页正常 |
| DOM `element.click()` | `isTrusted=false` | `isTrusted=false` | 明确的合成事件信号 |
| Patchright locator click | `isTrusted=true` | `isTrusted=true` | 协议级输入可信 |
| console Error.stack getter | 0 次 | 0 次 | 常见 CDP stack probe 未触发 |
| client console 事件 | 0 | 0 | 与 Patchright 禁用 Console API 接收一致 |
| 普通站点 Error stack | 无框架标识、无 evaluate 标识 | 同左 | 未见框架栈泄漏 |

补充说明：

- data URL 下 UA-CH 不可用、权限为 denied，local HTTP 下 UA-CH 正常且权限为 prompt，说明这两项强烈依赖 origin。不能把 data URL 结果直接当作平台页面结果。
- `window.chrome.runtime` 不存在不是可靠单点指标。
- WebGL、plugins 等结果只证明本机这一组配置没有显著低级异常，不代表跨机器或跨版本一致。

---

### 4. Patchright 源码事实与修补边界

#### 已确认的修补

Patchright README 明确说明：

- 避免使用 `Runtime.enable`
- 禁用 Console API 的 CDP 接收
- 增加 `--disable-blink-features=AutomationControlled`
- 移除 `--enable-automation`
- 移除部分 Playwright 默认参数
- 推荐 Chrome、headful、persistent context、`viewport: null`

源码与实测一致：

- `node_modules/patchright-core/lib/server/frames.js:585-650`
  - 通过 `Runtime.evaluate("globalThis")` 解析主世界 execution context，而非全局 `Runtime.enable`
  - utility world 通过 `Page.createIsolatedWorld` 创建
- `node_modules/patchright-core/lib/server/chromium/crPage.js:405-445`
  - 仍启用 `Page.enable`
  - 仍启用 `Log.enable`
  - 仍调用 `Page.addScriptToEvaluateOnNewDocument`
  - 仍调用 `Target.setAutoAttach`
- `node_modules/patchright-core/lib/server/chromium/chromium.js:264-320`
  - 仍使用 `--remote-debugging-pipe`
  - headless 时增加 `--headless`、`--hide-scrollbars`、`--mute-audio` 等
- `node_modules/patchright-core/lib/server/chromium/chromiumSwitches.js:53-88`
  - 默认仍加入一批禁用后台网络、后台 timer、后台渲染和功能开关的参数

因此，严格结论应为：

- **代码事实**：Patchright 修补了特定的 Runtime/Console/command flag 泄漏。
- **实测事实**：本轮已知的 `webdriver`、console stack、全局变量探针未检测到基础 Playwright 痕迹。
- **平台推断**：Patchright 没有移除 CDP 本身，也不承诺所有未来、私有或组合检测不可见。isolated world、CDP pipe、后台调度行为、iframe/worker 边界仍可能存在未知侧信道。

Patchright README 对“undetected”的说法带有明确前提：“with the right setup”。同一 README 推荐 `headless: false` 和 `viewport: null`，而项目当前固定 viewport，故不能直接套用该声明。

---

### 5. 风险分级

#### R1：合成 DOM 事件暴露自动化

- 级别：高
- 置信度：高
- 误报概率：低
- 代码事实：
  - `src/xhs/clients/services/explore.ts:533-534` 使用 `el.click()`
  - `src/xhs/clients/services/explore.ts:690-693` 直接设置 `textContent` 并派发 `input`
  - `src/xhs/clients/services/interact.ts:315-320` 同类直接输入
  - `src/xhs/clients/services/interact.ts:529-534` 手工创建并派发 `MouseEvent`
- 实测事实：
  - DOM `element.click()` 的 `isTrusted=false`
  - Patchright locator click 的 `isTrusted=true`
- 平台推断：
  - 若业务页面在事件处理器、埋点或风控 SDK 中记录 `isTrusted`，可直接区分这些动作。
  - 即使单次不拦截，也可与点击路径、输入事件序列、鼠标轨迹组合使用。
- 建议：
  - 删除所有以“模拟真实输入”为目的的 `evaluate(...dispatchEvent...)`。
  - 对写操作优先采用 locator click、keyboard、mouse 等浏览器输入通道。
  - 对无法通过可信 UI 事件完成的动作停止自动执行并转人工确认，不要继续构造事件。

#### R2：启用 headless 时 UA 明确暴露

- 级别：高（条件触发）
- 置信度：高
- 误报概率：低
- 代码事实：
  - 默认 headful：`src/core/config.ts:78-80`
  - 环境变量可以切换 headless
  - Patchright headless 启动时添加 `--headless`
- 实测事实：
  - headless UA 含 `HeadlessChrome`
  - headful UA 不含
  - headless 下 outer/inner 完全相等，色深也与 headful 不同
- 建议：
  - 把 headless 明确标为测试/只读模式。
  - 写操作启动前执行配置门禁，若 headless 则拒绝自动互动或发布。
  - 日志记录模式，但不要记录完整 UA。

#### R3：固定 viewport 与设备显示环境形成组合异常

- 级别：中
- 置信度：中高
- 误报概率：中
- 代码事实：
  - `src/xhs/clients/context.ts:24-29` 固定 viewport 为 1920×1080
  - Patchright README 推荐 `viewport: null`
- 实测事实：
  - headful 与 headless 均为配置值精确命中
  - 两种模式均出现 screen 与 viewport 相等
  - DPR 均为 1
  - headless outer/inner 完全相等
- 平台推断：
  - 单个 1920×1080、DPR 1 并不能证明自动化。
  - 大量账号、会话长期共享完全相同的显示参数，且和行为模板、设备/IP 重合时，风险显著升高。
- 建议：
  - 对真实用户驱动、headful 会话使用浏览器真实窗口尺寸，即 `viewport: null`。
  - 不建议随机伪造屏幕值；应保留真实设备一致性。
  - 在自动化测试中单独保留固定 viewport，不要把测试配置用于生产账号操作。

#### R4：Patchright 修补边界和未知 CDP 侧信道

- 级别：中
- 置信度：中低
- 误报概率：未知
- 源码事实：
  - 仍存在 remote debugging pipe、isolated world、`Runtime.evaluate`、`Page.enable`、`Target.setAutoAttach`
- 实测事实：
  - 本轮常见 console stack probe、全局名和普通 stack 均未发现泄漏
- 平台推断：
  - 无本地证据表明普通页面当前可以直接识别这些 CDP 调用。
  - iframe、worker、跨源隔离、DevTools 协议版本和 Chrome/Patchright 新版本可能产生新的差异。
- 建议：
  - 不把“Patchright 已安装”作为绕过风控的安全保证。
  - 每次升级 Chrome 或 Patchright 都运行离线回归探针。
  - 将版本不匹配、探针异常作为停止自动写操作的条件。

#### R5：后台调度与权限启动参数组合

- 级别：中低
- 置信度：低
- 误报概率：高
- 代码事实：
  - 项目及 Patchright 默认参数均禁用后台 timer throttling、后台渲染或后台窗口限制
  - 项目增加禁用通知和拒绝权限提示
- 实测事实：
  - 本轮仅测量前台页，timer/rAF 没有明显异常
  - 权限状态受 origin 强烈影响，local HTTP 为 prompt、data URL 为 denied
- 平台推断：
  - 长时间隐藏标签页的 timer、可见性和资源调度可能与普通 Chrome 不同。
  - 本轮没有足够时长或人工 Chrome 基线支持定性。
- 建议：
  - 删除与业务没有明确必要性的自定义启动参数。
  - 不重复 Patchright 已提供的开关。
  - 单独建立前台/后台 5–30 分钟生命周期基线后再决定是否保留。

---

### 6. 已确认的低风险或有效缓解项

以下项目本轮未发现明确问题：

- 使用系统 Google Chrome，而非 bundled Chromium。
- 默认是 headful。
- 未自定义 UA 或 HTTP header。
- `navigator.webdriver=false`，描述符形态正常。
- plugins/MIME 数量非空。
- UA-CH headful local HTTP 结果内部一致。
- WebGL 为 Apple/ANGLE 且非软件渲染。
- 主世界未发现 Playwright/Puppeteer/Selenium 全局变量。
- 常见 Error.stack getter 探针未触发。
- locator click 产生 `isTrusted=true`。

这些结论只覆盖对应单项，不能抵消行为、账号、IP、内容和操作图谱风险。

---

### 7. 误报与置信度说明

| 判断 | 置信度 | 主要误报来源 |
|---|---|---|
| DOM 合成事件可被识别 | 高 | 部分正常网页代码也会合成事件，但用户提交链路连续出现时误报较低 |
| headless UA 暴露 | 高 | 极少数合法自动化/测试工具本就使用 headless，但对“真人客户端”判断仍是强信号 |
| 固定 viewport 是风险组合 | 中 | 外接显示器、窗口最大化也可出现类似值 |
| Patchright 修补 webdriver/console stack 有效 | 高 | 仅覆盖本机 Chrome 150、Patchright 1.57.0 和已测试探针 |
| remote debugging pipe 会被平台直接识别 | 低 | 普通网页不能直接读取进程参数；需要未知侧信道 |
| 后台 timer 参数可稳定识别 | 低 | 未执行足够长的后台标签页对照 |
| `chrome.runtime` 不存在是异常 | 低 | 普通无扩展页面也可能不存在 |
| data URL 权限 denied 是自动化 | 不成立 | 已由 local HTTP 对照证明是 origin 差异 |

---

### 8. 尚未关闭的盲区

1. 未访问真实平台页面，因此未覆盖平台实际风控 SDK、CSP、跨源 iframe、worker、WASM 和私有采集字段。
2. 未使用真实 profile，也未采集 Cookie、扩展、缓存、历史记录、字体或登录状态。
3. 未建立“普通用户手动启动 Chrome、无 CDP”的同机基线。
4. 未测试 WebRTC、AudioContext、Canvas、字体枚举、媒体设备、Battery API 等扩展指纹。
5. 未测试 TLS/HTTP2/HTTP3、代理、DNS 和 Chrome/Node 双网络栈；这些属于网络专项。
6. 未执行长时间后台标签页 timer/visibility/CPU 调度测试。
7. 未覆盖跨源 iframe、dedicated/shared/service worker 的 execution-context 泄漏。
8. 未检查 macOS 进程、命令行或本机 DevTools pipe 的外部可见性。
9. Chrome 150 与 Patchright 1.57.0 的未来兼容性不能由一次测试保证。
10. 未采集平台侧判定结果，因此所有“平台会如何组合信号”的描述均为推断，不是已验证规则。

---

### 9. 整改优先级

第一阶段，立即处理：

1. 禁止在写操作中使用 headless。
2. 替换 `el.click()`、`dispatchEvent()`、直接 `textContent` 输入。
3. 对点赞、评论、发布等动作增加人工确认和失败关闭策略。
4. 将 Patchright、Chrome 版本及离线探针结果纳入启动门禁。

第二阶段：

1. headful 真实用户会话改为 `viewport: null`。
2. 精简项目自定义 Chrome 参数，只保留有明确功能依据的选项。
3. 分离生产账号会话与自动化测试配置。
4. 对运行时采集只保存布尔、分类、计数和短哈希。

第三阶段：

1. 建立同机手动 Chrome 基线。
2. 增加前台/后台生命周期回归。
3. 增加 iframe/worker/stack/CDP 回归。
4. 每次 Patchright 或 Chrome 升级后阻断式复测。

---

### 10. 复现信息

探针临时文件：

```text
/private/tmp/patchright_probe.js
```

运行命令：

```bash
node /private/tmp/patchright_probe.js headless
node /private/tmp/patchright_probe.js headful local-http
```

脚本特性：

- 固定使用 `/private/tmp/xhs-profile-patchright.gOESfw`
- 复用项目实际 channel、viewport 和 13 个启动参数
- headless 测试使用 data URL、offline、全路由阻断
- headful 测试仅允许 127.0.0.1
- 仅输出布尔、计数、类别和短哈希
- 不读取或输出真实账号数据

未修改仓库文件；仓库现有未跟踪文件保持不变。
