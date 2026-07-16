## 蓝军审查 1：浏览器、网络与上传链路指纹

审查方式：只读静态审计，未修改文件。以下“代码事实”均能由当前仓库直接确认；“平台信号”属于基于常见风控能力的合理推断，不代表已确认小红书正在使用该规则。

### P0

#### P0-1 多账户共享同一个 Chrome profile，数据库 state 实际未恢复

- 证据：
  - `src/core/config.ts:169-172` 只定义了全局 `browser-profile`。
  - `src/xhs/clients/context.ts:24-30` 所有账户都用该目录调用 `launchPersistentContext`。
  - `src/core/account-pool.ts:71-80` 虽把每个账户的 `state` 传给 `XhsClient`，但 `src/xhs/clients/context.ts:90-94` 启动时完全未使用 `options.state`。
  - `src/core/multi-account.ts:233-247` 默认并行启动多账户操作，锁只按账户隔离，不按共享 profile 隔离。
  - `src/core/login-session.ts:157-191` 新账号登录也打开同一 profile；如果其中已有登录态会直接报错。
- 确定事实：数据库中的 account state 只保存在内存字段，未注入新上下文；账户、代理、登录会话共享 cookies/localStorage/IndexedDB/cache/service worker/browser device state。
- 平台可观察信号（推断）：
  - 多个账号复用同一 `webId`、设备 cookie、本地设备标识和浏览器高熵指纹。
  - 同一设备状态短时间出现在多个代理 IP/ASN。
  - 账号切换时旧账号 cookie 与新账号身份交叉。
  - 并行启动同一 user-data-dir 通常还会遭遇 Chrome profile lock，形成异常重试/失败模式。
- 置信度：代码事实高；平台关联检测高。单账号部署误报低，多账号风险极高。
- 建议：每个 account 使用独立持久化 profile，并让 profile、数据库 state、代理一一绑定；加全局 profile 锁；迁移前清理已被多个账号共用的 profile。不要把隔离修复当成规避检测，而应作为账号数据安全边界。

#### P0-2 主动伪造 `webId`，且注释明确称用于绕过滑块

- 证据：
  - `src/xhs/utils/index.ts:25-32` 使用 `crypto.randomBytes(16)` 生成 32 位 hex，注释是 “to bypass slider verification”。
  - `src/xhs/clients/context.ts:37-46` profile 没有 `webId` 时，在访问正常发放流程前直接写入 `.xiaohongshu.com`。
- 确定事实：该 cookie 不是平台通过正常响应设置的；代码也没有校验签名、服务端发放记录、有效期或版本格式。
- 平台可观察信号（推断）：未知发放来源的值、cookie 首见时间与服务端 issuance ledger 不一致、缺少正常前序请求，均可直接形成反作弊特征。
- 置信度：高；若平台只检查格式而不保留发放记录则影响下降。正常用户不会由客户端随机生成该标识，误报低。
- 建议：禁用删除生成和注入逻辑；让平台在正常页面流程中设置标识。缺失时应失败关闭并要求重新认证，不能伪造设备标识或绕过验证。

#### P0-3 多处使用 `isTrusted=false` 的合成事件和直接 DOM 赋值完成副作用

- 证据：
  - 回复评论：`src/xhs/clients/services/interact.ts:315-320` 直接设置 `textContent`，随后 `dispatchEvent(new Event('input'))`。
  - 点赞评论：`src/xhs/clients/services/interact.ts:529-534` 手工构造并派发 `MouseEvent`。
  - Explore 打开笔记：`src/xhs/clients/services/explore.ts:529-535` 调用 DOM `el.click()`。
  - Explore 自动评论：`src/xhs/clients/services/explore.ts:690-693` 同样直接赋值并派发 input。
- 确定事实：脚本构造的 DOM 事件 `Event.isTrusted` 为 false；直接赋值没有真实键盘、IME、beforeinput、composition 或指针事件链。
- 平台可观察信号（推断）：前端埋点可直接读取 `isTrusted`，并检测 click 前无 pointerdown/mousedown、中文输入无 composition、整段文本瞬间出现。
- 置信度：很高，误报低。
- 建议：停止用 DOM 注入完成点赞、评论等副作用；平台未授权自动操作时改成人工确认或官方接口。授权测试也应在测试环境显式标记自动化流量，而非伪装成人类。

#### P0-4 Gemini 生成图直接进入发布链，存在机器可识别的 AI 来源信号

- 证据：
  - `src/core/config.ts:100-110` 默认使用 Gemini 图片生成模型。
  - `src/core/gemini.ts:414-437` 调用生成模型后原样保存返回的 image bytes。
  - `src/core/image-processor/graph/nodes/beautify.ts:181-205` AI 美化结果经 Sharp 重编码为 PNG。
  - `src/core/image-processor/graph/nodes/process.ts:63-85` Canvas 生成统一 PNG，无相机采集链路或来源信息。
  - `src/xhs/clients/services/publish.ts:131-138` 直接上传这些本地文件。
- 确定事实：项目提供明确的 AI 生成/美化到发布闭环，且大量产物是统一的程序化 PNG。
- 平台可观察信号（推断）：生成模型的像素级水印/生成器特征、缺失相机 EXIF、固定编码器 chunk/量化特征、统一尺寸与重编码模式。是否能检测 Gemini 水印需运行时样本验证。
- 置信度：AI 来源风险高，但只在使用生成/美化链路时触发；普通用户导出 PNG 也可能无 EXIF，单独据此误报中等。
- 建议：保留并披露 AI provenance，不要剥离水印；发布时遵守平台 AI 内容标注要求。不要把重编码作为规避生成内容识别的手段。

### P1

#### P1-1 代理只影响 Chrome，媒体下载走 Node 直连，产生双出口和双 TLS 指纹

- 证据：
  - `src/xhs/clients/context.ts:24-30` 代理只传给浏览器 context。
  - `src/tools/download.ts:76-88` 图片/视频用 Node `http/https.get`，没有 proxy、cookies、Referer 或浏览器 headers。
  - `src/tools/download.ts:178-188`、`265-274` 对账号刚取出的带关联 URL 直接发起 Node 下载。
  - `src/xhs/utils/index.ts:346-357` 发布 HTTP 图片前也用运行时 `fetch` 直连。
- 确定事实：同一业务操作可能先经 Chrome+账号代理访问页面，再由机器真实出口以 Node TLS/HTTP 栈访问平台 CDN。
- 平台可观察信号（推断）：页面请求与媒体 URL 请求来自不同 IP/ASN；Chrome JA4/HTTP2 与 Node TLS/HTTP 行为不一致；缺少账号 cookie、Sec-Fetch、Referer。
- 置信度：高；如果媒体 CDN 完全不关联访问日志则影响下降。
- 建议：优先使用平台支持的下载接口。确有授权时，所有账号相关网络访问应遵循同一明确的出口与认证策略，避免带账号关联的 URL 泄漏到旁路下载器。

#### P1-2 固定 viewport，但完全没有语言、时区、屏幕、字体和代理地理一致性策略

- 证据：`src/xhs/clients/context.ts:24-30` 启动选项只有 headless、Chrome channel、args、固定 `1920×1080` viewport 和 proxy；全仓未设置 `locale`、`timezoneId`、`screen`、`deviceScaleFactor`、`colorScheme`、geolocation、UA/client hints、字体配置，也没有 fingerprint/init script。
- 确定事实：UA 等沿用真实 Chrome/主机默认值，这是优点；但代理 IP 与主机语言/时区、固定 viewport 与真实屏幕尺寸可能不一致。
- 平台可观察信号（推断）：IP 地理位置、`Intl.DateTimeFormat` 时区、Accept-Language、navigator languages、字体集合、WebGL GPU、screen/inner/outer 尺寸组合不符合常见真实设备分布。
- 置信度：中高；不用代理且主机环境自然一致时误报较高。
- 建议：不要注入伪造随机指纹。优先取消不必要代理，使用真实、稳定、与账号实际使用环境一致的系统浏览器环境，并做一致性审计。

#### P1-3 headless 配置存在两个相互矛盾的默认值

- 证据：
  - `src/core/config.ts:78-84` 环境配置默认 headless=false。
  - `src/xhs/clients/browser.ts:111-115` 公共 `BrowserClient.init()` 默认却是 true。
  - `src/xhs/index.ts:74-75` `XhsClient.init()` 无参数调用上述默认值。
- 确定事实：通过公共 facade 初始化会无视 `XHS_MCP_HEADLESS=false` 的默认意图，实际进入 headless；MCP service 延迟初始化则多为 config 值。
- 平台可观察信号（推断）：不同调用入口产生两套指纹，headless 下 GPU、窗口尺寸、权限、后台调度和 UA/client hints 可能与 headful 不同。
- 置信度：代码事实高；Patchright/现代 Chrome 消除了多少 headless 差异需要实测，平台影响中等。
- 建议：以 config 为唯一默认源，删掉 `= true`；生产前对每个入口记录并断言实际 headless/channel/Chrome version。

#### P1-4 零延迟键盘输入、整段 fill 与高度固定的等待序列

- 证据：
  - `src/xhs/clients/services/publish.ts:140-186` 标题用 `fill` 瞬间写入，正文和标签用无 delay 的 `keyboard.type`，间隔大量固定为 300/500/1000ms。
  - 视频发布同样见 `src/xhs/clients/services/publish.ts:440-477`。
  - 评论见 `src/xhs/clients/services/interact.ts:205-231`，无 delay 输入后固定等待 300/1000ms。
  - 全局请求间隔默认固定 2000ms：`src/core/config.ts:80-84`、`src/xhs/clients/constants.ts:96-97`。
- 确定事实：输入和动作间隔是程序化的；中文输入没有真实 IME composition 过程。
- 平台可观察信号（推断）：字符间隔接近 0、整段 input 突变、所有会话在相同离散毫秒档位提交。
- 置信度：高，误报低到中。
- 建议：点赞、评论、发布等副作用改为人工确认或官方 API；不要简单“加随机数”伪装用户。读操作的限流应采用平台明确配额和退避策略。

#### P1-5 新 Page 直接打开笔记，却声明 `xsec_source=pc_feed`

- 证据：
  - `src/xhs/clients/services/content.ts:26-38` 新建页面后直接导航到带 `xsec_source=pc_feed` 的详情 URL。
  - 点赞/收藏同样见 `src/xhs/clients/services/interact.ts:29-40`、`110-121`。
  - 评论同样见 `src/xhs/clients/services/interact.ts:190-202`。
  - `navigateWithRetry` 每次直接 `page.goto`，见 `src/xhs/utils/index.ts:297-307`。
- 确定事实：导航来源参数声称来自 PC feed，但新 Page 顶级导航没有真实 feed 点击链和常规 Referer。
- 平台可观察信号（推断）：服务端 xsec 来源与 Referer/navigation history/前序曝光日志不一致；失败后还会重复直接导航最多 3 次。
- 置信度：中高；平台若只验证 token 而不校验曝光链则影响下降。
- 建议：不要伪造来源语义。使用平台认可的访问流程或接口，并在无合法前序曝光时失败关闭。

### P2

#### P2-1 非典型 Chrome flags 可形成权限与后台调度侧信号

- 证据：`src/xhs/clients/constants.ts:9-24` 使用 `--disable-background-timer-throttling`、`--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`、`--disable-notifications`、`--deny-permission-prompts` 等。
- 确定事实：这些 flags 改变通知权限、后台计时器和遮挡窗口行为。
- 平台可观察信号（推断）：页面可在 `visibilitychange` 后测量 timer throttle，或观察 Notification/permission 状态长期被拒绝。
- 置信度：中低；企业策略、无头测试和隐私设置也会产生相同信号，误报高。
- 建议：最小化启动参数，优先使用 Chrome 默认行为；逐项证明参数必要性。

#### P2-2 `setInputFiles` 上传路径与程序化 PNG 元数据组合可形成辅助特征

- 证据：
  - 图片上传：`src/xhs/clients/services/publish.ts:131-138`。
  - 视频/封面上传：`src/xhs/clients/services/publish.ts:416-436`。
  - 程序化 PNG：`src/core/image-processor/graph/nodes/process.ts:63-85`、`beautify.ts:197-205`。
- 平台可观察信号（推断）：上传 input/change 事件序列、文件命名、无采集元数据、编码器指纹和上传后立即填表的节奏可作为组合特征；单独 `setInputFiles` 是否产生可区分的 trusted 事件需运行验证。
- 置信度：低到中，单项误报高。
- 建议：保留真实来源与 provenance；AI 内容合规标注；不要为降低检测而篡改元数据。

### 做得好的部分

- `package.json:69-70` 使用 Patchright，`src/xhs/clients/context.ts:24-28` 使用系统 Chrome channel；相比裸 Playwright+bundled Chromium，能减少基础自动化/版本异常。
- `src/core/config.ts:78-84` MCP 主流程默认 headful。
- 未硬编码自定义 UA，因此实际 Chrome UA、client hints 与 TLS 栈更容易自然一致。
- 浏览器页面流量走真实 Chrome 网络栈，且支持账户代理。
- 持久化 profile 对单账号 cookies、cache、service worker 连续性有帮助，问题在于没有按账号隔离。
- `src/xhs/utils/index.ts:84-151` 搜索滚动包含缓动、距离扰动、鼠标移动和偶发回滚。
- `src/core/account-lock.ts:71-89` 能串行化同一账号操作。
- 互动结果增加了 outcome 确认和 `sideEffectPossible`，降低错误重试导致的重复副作用。

### 审查盲区

- 这是静态审查；没有真实访问小红书、没有验证当前平台规则。
- 工作区未安装 `node_modules/patchright`，无法运行时确认 Patchright 1.57 对 CDP `Runtime.enable`、execution context、webdriver、stack trace 等痕迹的具体修补效果。
- 未采集真实 navigator、UA-CH、WebGL、Canvas、Audio、字体、permissions、WebRTC、screen/outer/inner、headless/headful对照。
- 未获得实际 Chrome 版本、操作系统字体/GPU、代理 ASN/地理位置、TLS/HTTP2/HTTP3 抓包。
- 未检查用户真实 `~/.xhs-mcp/browser-profile`，因此不知道历史 cookie 是否已跨账号污染。
- Gemini 像素水印/生成器特征需要用真实输出样本和授权检测器验证。
- 平台是否关联 CDN、页面曝光、xsec、Referer 和账号图谱属于服务端黑盒，只能推断。

优先顺序建议：先处理共享 profile/state 与伪造 webId，再停止 synthetic DOM 副作用，随后统一 headless 配置和网络出口；AI 图片链路应同步做 provenance 与平台标注合规。
