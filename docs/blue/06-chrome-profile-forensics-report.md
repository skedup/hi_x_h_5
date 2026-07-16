## 真实 Chrome Profile 脱敏取证专项报告

### 1. 范围与约束

- 仅分析隔离副本，未访问或修改真实 profile。
- 未启动 Chrome/Patchright，未联网，未触发任何平台操作。
- Cookie、token、账号 ID、手机号、昵称、URL 查询参数均未解密或输出。
- 身份相关状态只使用键名、计数、长度和集合基数。
- 未读取项目业务数据库，因此不能由本专项确认数据库里注册了几个小红书账号。

### 2. 基础清点

| 项目 | 脱敏结果 |
|---|---:|
| 副本体积 | 约 685 MB |
| 文件数 | 14,652 |
| Chrome profile | 仅一个 `Default` |
| `Last Version` | Chrome 150.0.7871.115 |
| 可观察的小红书状态时间窗 | 2026-07-14 17:18 至 2026-07-15 19:08 |
| 用户扩展 | 未发现 `Extensions` 目录；Preferences 中扩展设置数为 0 |
| Chrome 浏览器账号 | 存在 1 个已登录浏览器账号条目，未读取其身份 |
| Profile 退出状态 | `Crashed` |
| 隔离副本 Singleton 文件 | 0 |
| SQLite 快速一致性检查 | Cookies、History、Web Data、Login Data、DIPS 等均为 `ok` |

存在以下持久化结构：

- Cookies、History、Web Data、Login Data
- Local Storage、Session Storage
- IndexedDB
- Service Worker、CacheStorage、ScriptCache
- MediaDeviceSalts
- DIPS、WebStorage、网络预测和报告数据库

这不是一次性或空白自动化 profile，而是一个保存了完整浏览器历史与站点状态的长期持久化环境。

### 3. 小红书相关聚合指标

#### 3.1 Cookies

- 小红书相关 Cookie 共 16 个，分布于 2 个小红书域名。
- 所有值均为 Chrome 加密值，未读取明文。
- 当前仅观察到一组关键身份/设备锚点：

  - `web_session`：1
  - `id_token`：1
  - `webId`：1
  - `a1`：1
  - `gid`：1
  - 其余请求、防护、国家和构建版本类键各 1

- 没有重复的 `host + path + name` Cookie 键。
- Cookie 数据库完整性检查通过。
- 当前快照表现为一个现行小红书会话，不能由 Cookie 表证实同时存在多个小红书登录身份。

#### 3.2 History

| 指标 | 数量 |
|---|---:|
| 小红书 URL 记录 | 114 |
| 小红书访问记录 | 296 |
| `TYPED` 核心跳转 | 197，约 66.6% |
| `TYPED` 且无前序访问 | 185，约 62.5% |
| 含 xsec 参数的 URL 记录 | 80 |
| 笔记详情记录 | 71 |
| 搜索记录 | 20 |
| 用户主页记录 | 13 |
| 创作者中心记录 | 5 |

高比例 `TYPED`/无前序访问跳转，且大量详情页同时带有来源参数，和项目中 `page.goto()` 直接打开笔记/用户地址的实现高度吻合。它是实际 profile 中已经留下的自动化式导航轨迹。

但 `TYPED` 不能单独证明每一次访问都由自动化产生，浏览器和库也可能把部分程序化导航记录为该类型。结合源码后，判定为“高置信度自动化轨迹”，而非平台已经识别的直接证据。

#### 3.3 站点持久化状态

- Local Storage、Session Storage、Service Worker 中均有小红书域名数据。
- 创作者中心存在独立 IndexedDB 和 blob 数据。
- 小红书 origin 存在 1 个 MediaDeviceSalt。
- DIPS 中存在小红书用户激活记录。
- Chrome Password Manager 中没有保存小红书登录凭证。
- 固定键名扫描可见 `device_id`、`userId`、`accountId` 等代码或状态字段，但 LevelDB 缺少可靠解析工具，且这些字段可能来自脚本、缓存内容、笔记作者或当前用户，不能拿来证明多个登录账号。
- IndexedDB 中还存在至少一个非小红书站点 origin，证明该 profile 不是严格的小红书专用环境。

### 4. 环境复用与一致性取证

#### 能证实

1. **Profile 被迁移或复用过**

   LevelDB 内部日志记录过至少两个不同的绝对目录根。该证据能够证明同一 profile 数据曾在不同工作区路径运行或被迁移。

2. **Profile 不是账号隔离容器**

   源码为所有客户端调用同一个：

   ```text
   dataDir/browser-profile
   ```

   `launchPersistentContext()` 不根据 `accountId` 选择目录。

3. **数据库账号 state 没有在运行时恢复**

   `AccountPool` 将 `account.state` 传入客户端，但 `BrowserContextManager.init()` 只使用 proxy，未应用 `options.state`。因此真实认证来源是共享持久化目录，而不是数据库中的账号级 state。

4. **所有账号会共享 origin 级设备状态**

   Cookie、Local Storage、IndexedDB、Service Worker、MediaDeviceSalt 都属于同一个 `Default` profile。若多个业务账号经这个目录切换，它们必然共享或覆盖这些设备/站点锚点。

5. **该 profile 还绑定了一个 Chrome 浏览器账号**

   这会把自动化环境与更广泛的浏览器身份、同步状态或其他站点使用痕迹关联起来。未读取具体身份。

6. **存在版本跨度**

   - 安装的 Patchright：1.57.0
   - 其 bundled Chromium 元数据：143.0.7499.4
   - Profile 最近写入版本：Chrome 150.0.7871.115
   - 源码使用 `channel: 'chrome'`

   实际运行很可能是 Chrome 150，而不是 Patchright 对应的 Chromium 143。不能仅凭版本差判定不可用，但七个大版本的协议跨度增加兼容性、行为漂移和特征不一致风险。

7. **快照不是完全干净的关闭态**

   - Preferences 显示 `Crashed`
   - History journal 非空
   - DIPS WAL 约 1.8 MB
   - LevelDB 日志包含 recovery/复用旧日志记录
   - 隔离副本没有 Singleton 文件

   SQLite 检查通过，但这不能证明复制时原 profile 没有活跃进程。

#### 不能证实

1. **不能证实曾登录多个小红书账号**

   当前只有一组现行会话 Cookie。旧账号值可能已被覆盖；静态 Cookie 表不保存可靠切换历史。

2. **不能证实当前 `webId` 是客户端生成还是平台写入**

   键的创建时间和长度与项目生成逻辑兼容，但未解密值，也没有写入来源审计。

3. **不能判断代理、出口 IP、TLS 指纹是否一致**

   Proxy 由启动参数传入，不写入 Preferences；本次没有启动浏览器或抓包。

4. **不能判断运行时语言、时区、GPU、WebGL、字体、`navigator.webdriver`**

   Profile 只显示选择语言为中文，拼写词典为英文；这不足以构成矛盾，也不能代表 JS 运行时结果。

5. **不能确认真实 profile 在复制时是否仍被 Chrome 占用**

   隔离副本没有 Singleton 文件不代表源目录没有锁。

6. **不能完成 LevelDB 逻辑完整性和删除记录恢复**

   缺少适配 Chrome LevelDB/IndexedDB 编码的只读解析器；本轮只检查目录、日志、域名和允许输出的键名聚合。

### 5. 对上一报告 P0-1 的判定

结论：**源码层面被完全证实；当前 profile 提供了强支持证据，但不能证明已经发生多账号身份碰撞。**

证据链：

```text
多个 DB 账号
   ↓ account.state 被传入
BrowserContextManager
   ↓ state 未应用
同一个 persistent profile
   ↓
同一 Cookies / LocalStorage / IndexedDB / ServiceWorker / MediaDeviceSalt
```

- “所有账号共享 profile”置信度：**确定**
- “数据库 state 实际被忽略”置信度：**确定**
- “账号切换会覆盖或复用身份/设备锚点”置信度：**高**
- “该副本已经包含两个以上小红书登录身份”置信度：**不足，不能下结论**

当前只有一个现行 `web_session` 并不能降低架构风险；它更可能说明共享 profile 在任一时刻只能自然地表示一个主会话。

### 6. 风险分级

#### P0：多账号认证与设备状态未隔离

- 证据：单一持久化目录、账号 state 未应用、单一 origin 设备盐与会话集。
- 影响：账号串用、误操作、代理与身份错配、平台侧账号关联、删除一个账号 Cookie 导致其他账号同时掉线。
- 置信度：**高；架构事实为确定**
- 建议：在完成账号级 profile 隔离前，禁止多账号写操作和自动互动。

#### P1：真实 profile 已留下高比例直接导航轨迹

- 证据：约 66.6% 小红书访问为 `TYPED`，约 62.5% 无前序访问，大量带来源参数的详情页直接打开。
- 影响：页面来源、历史链、referrer、用户行为序列可能互相矛盾。
- 置信度：**高**
- 建议：不要以“伪装来源”方式修补；应减少自动互动，使用合规 API 或显式人工确认，并保留真实导航上下文。

#### P1：Profile 迁移和混合用途导致环境关联

- 证据：两个不同历史目录根、非小红书 IndexedDB、一个 Chrome 登录账号。
- 影响：自动化账号与个人浏览器身份、其他站点、历史设备状态形成稳定关联。
- 置信度：**高**
- 建议：使用全新的专用 profile，不迁移现有 Cookies/LocalStorage。

#### P1：快照/运行生命周期不干净

- 证据：`Crashed`、非空 journal/WAL、LevelDB recovery。
- 影响：数据库状态不一致、Cookie 更新丢失、并发启动失败、错误账号状态被持久化。
- 置信度：**中高**
- 建议：实现进程级 profile 租约与干净关闭门禁。

#### P1：Chrome 与 Patchright 版本跨度

- 证据：Patchright 对应 Chromium 143，profile 最近由 Chrome 150 写入。
- 影响：协议兼容性、选择器和输入行为漂移、补丁假设失效。
- 置信度：**中**
- 建议：固定并验证浏览器版本，升级自动化库后再滚动升级 Chrome。

#### P2：取证与状态审计不足

- 证据：数据库 state 与真实 profile 来源分裂；无法从业务日志判断某次操作使用了哪个 profile、Cookie 代际、代理或浏览器版本。
- 影响：串号或封禁事件发生后难以归因。
- 置信度：**高**
- 建议：记录不可逆的 profile ID、账号映射、版本、代理策略编号和会话代际，不记录原始凭证。

### 7. 安全迁移建议

1. 暂停多账号批量写入、评论、点赞和发布。
2. 改为严格的一账号一目录：

   ```text
   browser-profiles/{accountId-derived-internal-id}/
   ```

   目录名使用内部随机 ID，不使用昵称、手机号或平台 userId。

3. 在 `accounts` 表保存不可变 `profile_id`，启动时校验：

   - accountId 与 profileId 一一对应
   - 同一 profile 不得同时分配给两个账号
   - profile 只能被一个进程持有
   - 实际 proxy 策略与账号配置一致

4. Persistent Context 架构下，删除容易误导的账号 `storageState` 恢复逻辑；或者改成非持久化 context 并真正应用账号级 `storageState`。两种模型不要混用。

5. 不要复制旧 profile 的 Cookies、Local Storage、IndexedDB 或 Service Worker。对每个账号创建全新 profile，并由用户逐个手工重新认证。

6. 旧 profile 应先停止进程、确认无锁、干净关闭后做加密归档；归档设置保留期限，不能作为新账号模板。

7. 不要在自动化专用 profile 登录 Chrome 同步账号，也不要用于其他站点浏览。

8. 浏览器版本采用受控升级：

   - Patchright 与目标 Chrome 版本组合进入兼容矩阵
   - 先在本地测试页验证，再灰度
   - profile 禁止被更高版本 Chrome 打开后又回退

9. Cookie 删除应按 profile/账号执行，禁止共享 context 上全局 `clearCookies()`。

### 8. 后续动态验证建议

优先使用本地测试页和无平台副作用的读操作。

#### A. Profile 隔离门禁

对两个测试 profile 只输出带盐 HMAC 和集合比较结果：

- `web_session` 是否不同
- `webId` 是否不同
- MediaDeviceSalt 是否不同
- Local Storage origin 数据是否互相不可见
- 删除 A 的 Cookie 后 B 是否不受影响

验收标准：身份与设备锚点跨 profile 不相等，且生命周期完全独立。

#### B. 账号状态一致性

每次启动记录：

- internal account ID
- internal profile ID
- browser major version
- Patchright version
- proxy policy ID
- session generation
- clean-shutdown 标志

不记录原始 Cookie、token、平台账号 ID 或代理密钥。

#### C. 本地运行时指纹检查

使用本地页面采集并比较：

- UA、platform、语言、时区
- viewport/screen/devicePixelRatio
- WebGL/GPU、字体、媒体设备基数
- `navigator.webdriver`
- 输入事件 `isTrusted`
- 权限状态和通知策略

结果只与声明配置做一致性检查，不用于规避平台检测。

#### D. 导航链检查

在本地或明确授权的测试账号上采集：

- referrer 是否与页面来源一致
- History transition 分布
- 页面打开前是否存在真实前序访问
- 来源参数是否与导航路径一致
- 同一操作是否重复创建新页面和孤立历史节点

#### E. 生命周期检查

复制或备份前必须满足：

- 浏览器进程已退出
- Singleton 不存在
- Preferences 为正常退出
- SQLite journal/WAL 已稳定
- LevelDB 日志无未完成 recovery/corruption
- 副本完成后再次运行只读完整性检查

### 9. 最终结论

真实 profile 将上一报告的 P0-1 从“纯源码推断”提升为“源码确定、实物强支持”：

- 这是一个真实、长期、混合用途、迁移过的 Chrome profile。
- 它当前只表现出一个小红书会话，但所有账号都被代码映射到这个单一会话容器。
- 多账号碰撞是否已经发生无法由当前静态快照证明；一旦启用多个账号，身份和设备锚点无法隔离则是架构必然结果。
- 当前最重要的整改不是继续增加反检测参数，而是停止共享 profile、建立账号级持久化隔离、清理个人浏览器关联，并补齐会话生命周期与取证审计。
