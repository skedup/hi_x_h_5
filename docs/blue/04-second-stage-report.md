## 第二阶段蓝军专项报告：事件、输入、上传与网络差异

### 1. 实验边界

- Patchright：`1.57.0`
- Chrome Channel：`150.0.7871.115`
- 隔离 profile：`/private/tmp/xhs-profile-events.bvhfTU`
- 页面与服务：仅 `127.0.0.1` 本地 HTTP
- 未启动、读取或修改真实 profile
- 未主动请求小红书或其他外部 URL
- 正式实验使用以下外联隔离：
  - `--host-resolver-rules=MAP * 127.0.0.1,EXCLUDE 127.0.0.1`
  - `--disable-background-networking`
  - Patchright route 拒绝所有非 `127.0.0.1` 页面请求
- 未做系统级抓包，因此只能确认实验脚本与页面请求记录全部为 loopback，不能从内核层面证明 Chrome 没有任何不可见后台 egress。

产物：

- 原始结果：`/private/tmp/xhs-event-network-results.json`
- 复现脚本：`/private/tmp/xhs_event_network_lab.js`
- JSON SHA-256：`dd5242e867d14c359daf00d35879defe33c276d36a1bd057efcdf3bd10ac5dc3`
- 未修改仓库文件。

---

## 2. 事件链实测

### 2.1 Locator / ElementHandle click

项目大量使用 `ElementHandle.click()`，与实验中的 locator click 属同一浏览器输入路径，例如：

- `src/xhs/clients/services/interact.ts:208-230`
- `src/xhs/clients/services/explore.ts:615`
- `src/xhs/clients/services/publish.ts:154-180`

实测序列：

```text
pointerover
pointerenter × 4
pointermove
pointerdown
mousedown
focus
focusin
pointerup
mouseup
click
```

量化：

- 共 13 个事件
- 所有事件 `isTrusted=true`
- 12/12 相邻间隔小于 1 ms
- 中位间隔 0 ms，最大 0.4 ms

结论：

- “Patchright click 会产生不可信事件”这一说法不成立。
- 它产生完整、可信的浏览器事件链。
- 但事件链压缩在亚毫秒级，页面脚本若记录高精度事件时间，可以观察到极强的同步突发特征。
- `isTrusted` 单独不能识别这种自动点击；时序和轨迹联合分析才有区分力。

### 2.2 `HTMLElement.click()`

对应：

- `src/xhs/clients/services/explore.ts:533-535`

实测：

```text
click
```

- 仅 1 个事件
- `click.isTrusted=false`
- 没有 pointer、mouse、focus 前序事件

这是直接可由页面事件监听器确认的强信号。

### 2.3 `dispatchEvent(new MouseEvent(...))`

对应：

- `src/xhs/clients/services/interact.ts:529-534`

实测：

```text
click
```

- 仅 1 个事件
- `isTrusted=false`
- 无 pointerdown、mousedown、pointerup、mouseup

代码注释称其为“真实点击事件”，但动态结果证明该注释不准确。

风险：P0。平台前端只需在目标控件的捕获阶段读取 `event.isTrusted`，即可区分这两条路径。

---

## 3. 文本输入实测

### 3.1 `fill()`

对应发布标题：

- `src/xhs/clients/services/publish.ts:142-145`
- `src/xhs/clients/services/publish.ts:441-444`

ASCII 11 字符：

```text
focus → focusin → beforeinput → input
```

- 整段文本在单个 `beforeinput/input` 中写入
- `data.length=11`
- `inputType=insertText`
- `isTrusted=true`

中文 6 字符：

```text
beforeinput → input
```

- 整段 6 字符一次写入
- 没有 key 或 composition 事件
- 两事件间隔 0.2 ms

中文长文本 300 字符：

```text
beforeinput → input
```

- 300 字符一次写入
- 两事件间隔 0.3 ms
- 没有键盘或输入法事件

结论：

`fill()` 虽然生成可信事件，但整段标题或长文本瞬时出现。它与真人逐字输入不同，也与常见 IME 组合输入不同；更像程序赋值或粘贴。

误报来源包括粘贴、密码管理器、浏览器自动填充和无障碍工具，因此不能单独作为封禁依据。

### 3.2 无 delay `keyboard.type()`：ASCII

对应：

- `src/xhs/clients/services/interact.ts:220-222`
- `src/xhs/clients/services/publish.ts:154-175`
- `src/xhs/clients/services/publish.ts:449-459`

输入 11 个 ASCII 字符：

- 55 个事件
- 每字符固定 5 个：

```text
keydown → keypress → beforeinput → input → keyup
```

量化：

- 所有事件 `isTrusted=true`
- 54/54 相邻间隔小于 1 ms
- 中位间隔 0.1 ms
- 最大间隔 0.7 ms

输入 300 个 ASCII 字符：

- 1500 个事件
- 1499/1499 相邻间隔小于 1 ms
- 中位间隔 0 ms
- 最大间隔 0.7 ms

结论：

这不是事件缺失问题，而是完整键盘事件以接近 CPU 执行速度连续发生。页面可通过字符间隔、总输入耗时、方差、退格率和停顿分布识别。

### 3.3 无 delay `keyboard.type()`：中文

输入 6 个中文字符：

```text
beforeinput → input
beforeinput → input
...
```

量化：

- 12 个事件
- 每个中文字符仅有 `beforeinput/input`
- 无 `keydown`
- 无 `keypress`
- 无 `keyup`
- 无 `compositionstart/update/end`
- 所有 `beforeinput/input` 为 `isTrusted=true`
- 11/11 间隔小于 1 ms
- 中位 0.1 ms，最大 0.2 ms

结论：

该路径在本次 Chrome/Patchright 组合下没有模拟中文输入法，而是逐字符直接插入 Unicode。它同时具备：

- 可信事件
- 无键盘事件
- 无 composition 事件
- 几乎零输入间隔

这是比 ASCII 输入更明显的组合特征。

但中文可通过粘贴、语音输入、无障碍工具或程序化编辑器插入，因此仍不应仅凭缺少 composition 判定自动化。

### 3.4 `textContent + dispatchEvent(input)`

对应：

- `src/xhs/clients/services/interact.ts:315-320`
- `src/xhs/clients/services/explore.ts:690-693`

中文 6 字符和长文本 300 字符结果一致：

- 内容同步整体出现
- 目标元素仅收到 1 个 `input`
- 该 `input.isTrusted=false`
- 无 `beforeinput`
- 无 key 事件
- 无 composition 事件
- `inputType` 为空
- `data` 为空

风险：P0。

这是整个输入链中最容易被页面侧确定性识别的路径。

---

## 4. 文件上传实测

对应：

- `src/xhs/clients/services/publish.ts:131-133`
- `src/xhs/clients/services/publish.ts:417-435`

`setInputFiles()` 产生：

```text
input → change
```

量化：

- 两个事件均 `isTrusted=true`
- 间隔 0.1 ms
- 文件数正确
- 没有文件选择按钮的 click、pointer 或 focus 前序链

结论：

平台不能通过 `isTrusted` 直接识别 `setInputFiles()`；但可以观察到文件输入控件在没有用户打开 file chooser 的事件前提下直接发生 `input/change`。

误报包括拖放上传、粘贴上传、页面调用隐藏 input、辅助技术以及系统恢复表单，因此建议定为 P2，作为组合信号使用。

---

## 5. Deep-link 与 `xsec_source` 实测

项目直接创建新页面并导航到：

```text
/explore/{noteId}?xsec_token=...&xsec_source=pc_feed
```

例如：

- `src/xhs/clients/services/interact.ts:190-201`

本地构造两种相同 `xsec_source=pc_feed` 的访问：

| 项目 | 新页面直接进入 | 从 feed 点击进入 |
|---|---:|---:|
| URL source | `pc_feed` | `pc_feed` |
| `document.referrer` | 空 | `/feed` |
| HTTP Referer | 无 | `/feed` |
| `Sec-Fetch-Site` | `none` | `same-origin` |
| history length | 2 | 3 |
| navigation type | `navigate` | `navigate` |

结论：

URL 声明为 `pc_feed` 并不能伪造 feed 导航上下文。服务器至少能同时看到：

- `xsec_source=pc_feed`
- 无 Referer
- `Sec-Fetch-Site: none`

而实际站内点击为：

- Referer 存在
- `Sec-Fetch-Site: same-origin`

风险：P1，高置信度且服务器侧可观察。

`history.length` 受标签页和恢复历史影响，只能作为弱信号。

---

## 6. Chrome 与 Node 网络栈差异

代码事实：

- 浏览器请求使用 Patchright Chrome context，可配置账号代理。
- `src/xhs/utils/index.ts:356` 使用 Node 全局 `fetch()` 下载图片。
- `src/tools/download.ts:76-82` 使用 Node `http.get/https.get`。
- Node 下载路径没有复用浏览器 cookie jar，也没有看到复用账号 proxy 的代码。

### 6.1 Chrome 页面请求

本地 Chrome fetch 包含：

- 浏览器 Cookie
- Referer
- `sec-ch-ua*`
- `Sec-Fetch-Site`
- `Sec-Fetch-Mode`
- `Sec-Fetch-Dest`
- Chrome User-Agent
- Accept / Accept-Language

### 6.2 Node `fetch()`

实测包含：

- Node/Undici User-Agent
- `Sec-Fetch-Mode: cors`
- Accept / Accept-Language / Accept-Encoding

缺少：

- 浏览器 Cookie
- Referer
- `sec-ch-ua*`
- `Sec-Fetch-Site`
- `Sec-Fetch-Dest`

### 6.3 Node `http.get()`

实测只有：

- Host
- Connection

缺少 User-Agent、Cookie、Referer 和全部浏览器 client hints/fetch metadata。

### 6.4 HTTP 版本

在本地明文 HTTP 服务上三者均为 HTTP/1.1，因此本实验没有证明 HTTP 版本存在差异。

未测试：

- HTTPS
- ALPN
- HTTP/2 或 HTTP/3
- TLS ClientHello
- JA3/JA4
- TCP 特征
- 真实代理出口 IP

所以“浏览器和 Node 一定具有不同 TLS 指纹或 HTTP 版本”仍是平台推断，不是本次实测结论。

但请求头、cookie jar、Referer 和 Fetch Metadata 差异已经被本地实测确认。若浏览器操作和 Node 媒体请求都抵达平台可关联的域名/CDN，可能形成双客户端栈特征，风险 P1。

---

## 7. Project flags 动态结果

对应：

- `src/xhs/clients/constants.ts:10-24`
- `src/xhs/clients/context.ts:24-28`

比较无项目 flags 与项目 flags，均使用 Patchright、Chrome channel、headless 和隔离 profile。

### 7.1 `navigator.webdriver`

两组均为：

```text
navigator.webdriver === false
```

因此此次实验不能通过该属性区分项目浏览器与基线 Patchright。

### 7.2 visibility

将被测标签页切到后台后：

- 两组均从 `visible` 变成 `hidden`
- `document.hidden === true`

因此：

- `--disable-backgrounding-occluded-windows`
- `--disable-renderer-backgrounding`

没有隐藏 `visibilityState`；站点仍能知道标签页处于后台。

### 7.3 timer

后台运行 5 秒，20 ms interval：

| 指标 | 基线 | 项目 flags |
|---|---:|---:|
| tick 数 | 250 | 250 |
| 中位间隔 | 20.1 ms | 20.1 ms |
| P95 | 21.2 ms | 21.2 ms |
| 最大间隔 | 27.9 ms | 29.4 ms |

5 秒窗口内没有观察到 `--disable-background-timer-throttling` 带来的可区分效果。

Chrome 更强的后台节流通常需要更长后台时间或不同运行状态，本实验不能证明该 flag 无效，也不能证明平台能据此识别。

### 7.4 Notification API

- 基线：`Notification.permission = "default"`
- 项目 flags：`typeof Notification === "undefined"`
- Permissions API 查询两组均为 `prompt`

`--disable-notifications` 在本次运行中让全局 Notification API 消失，而不仅是拒绝权限。这是页面脚本可观察的异常。

风险：P2。需要在真实 headful Chrome、多版本和不同系统上复测后才能提升等级。

---

## 8. 风险分级

### P0：确定性页面侧信号

1. `HTMLElement.click()` 仅产生不可信 click  
   `src/xhs/clients/services/explore.ts:533-535`

2. `dispatchEvent(MouseEvent)` 仅产生不可信 click  
   `src/xhs/clients/services/interact.ts:529-534`

3. `textContent + Event('input')` 仅产生不可信 input，且缺少完整输入链  
   `src/xhs/clients/services/interact.ts:315-320`  
   `src/xhs/clients/services/explore.ts:690-693`

### P1：高强度组合信号

1. 无 delay `keyboard.type()` 的亚毫秒输入突发
2. 中文输入完全缺少键盘和 composition 事件
3. `fill()` 整段瞬时写入，长达 300 字也只有一组事件
4. `pc_feed` source 与 Referer / Sec-Fetch 上下文冲突
5. Chrome 和 Node 下载栈的 headers、cookie、Referer 差异
6. 账号代理可能仅覆盖 Chrome、未覆盖 Node 下载——代码事实支持，但 IP 差异未动态验证

### P2：辅助信号

1. `setInputFiles()` 无用户文件选择事件链
2. `--disable-notifications` 导致 Notification API 不可用
3. Locator click 虽完整可信，但事件链压缩到亚毫秒级
4. history length 差异

---

## 9. 修复建议与门禁

整改目标应是降低非授权自动化和误伤风险，而不是继续伪造真人行为。

### Gate 1：禁止不可信事件路径

静态门禁禁止在写操作代码中出现：

- `HTMLElement.click()`
- `dispatchEvent(new MouseEvent(...))`
- `textContent = ...` 后手工 `dispatchEvent(input)`

验收：本地事件测试中，不再出现业务目标上的 `isTrusted=false` click/input。

### Gate 2：高风险互动改为人工确认

点赞、评论、回复和发布属于有外部副作用的行为：

- 自动浏览可保留为只读
- 写操作进入可见页面，由用户确认
- 评论文本在提交前必须允许用户编辑
- 不应通过加入随机 delay 来把程序输入伪装成人类输入

### Gate 3：修正来源语义

- 直接访问笔记时不要声明 `xsec_source=pc_feed`
- 只有真实从 feed 页面选择并点击时才使用 feed 来源
- 测试门禁同时检查 URL source、Referer 和 Sec-Fetch-Site 一致性

### Gate 4：网络出口与会话边界

- 建立浏览器和 Node egress 清单
- 明确哪些媒体 URL 可以由 Node 下载
- 不让 Node 请求隐式冒充浏览器会话
- 对代理、cookie、Referer、重定向和平台授权边界建立显式策略
- 使用 HTTPS/H2 测试环境补充 ALPN/TLS 指纹回归，不得在真实平台上试探

### Gate 5：上传流程

- 发布前保留人工文件选择或明确的人机确认步骤
- 对隐藏 input 的直接 `setInputFiles()` 标记 automation provenance
- 禁止自动上传完成后直接自动发布

### Gate 6：最小化启动参数

优先移除没有业务必要的“anti-detection”参数，特别是：

- `--disable-blink-features=AutomationControlled`
- 三个 background/timer 参数
- `--disable-notifications`

验收：

- 页面标准 API 与正常同版本 Chrome 一致
- 不依赖隐藏 automation 属性作为合规保障
- headful Chrome 上复测 visibility、permissions、notification 和 timer

---

## 10. 结论边界

本次已经把上一轮部分静态推断收窄为动态事实：

- 可以确认原生 `click()`、手工 MouseEvent、手工 input 是不可信事件。
- 可以确认 Patchright locator click、fill、keyboard.type、setInputFiles 反而能产生可信事件。
- 因此不能笼统声称“自动化事件都是 `isTrusted=false`”。
- 可以确认无 delay 输入具有亚毫秒突发特征。
- 可以确认中文 `keyboard.type()` 没有 key/composition 链。
- 可以确认 direct navigation 无法仅靠 URL 参数伪造 feed Referer/Sec-Fetch 上下文。
- 可以确认 Node 与 Chrome 请求头和会话上下文明显不同。
- 不能确认真实平台正在采集或采用这些信号。
- 不能确认平台阈值、权重或最终处罚策略。
- 不能确认真实 HTTPS/TLS/HTTP2 指纹和出口 IP 差异。
- 不能确认 headful 模式、真实站点 CSP/编辑器框架下事件完全一致。
- 本次仅单轮测量；事件形状置信度高，亚毫秒具体数值仍需多轮统计。
