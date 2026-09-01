# Kindred XHS 正式发行

本仓是 Xiaohongshu Portable Capability、package-owned 生活资产与 loopback sidecar 的直接源码
权威。正式 tag 同时产出：

- `kindred-capability-xiaohongshu` wheel；
- `macos-arm64` sidecar bundle；
- `ubuntu-24.04-x86_64` sidecar bundle；
- 每个 bundle 的 SHA-256、成员 manifest、CycloneDX SBOM、MIT LICENSE 与第三方许可清单。

sidecar bundle 固定携带 Node 22.18.0、编译后的 JS 与目标平台生产依赖。目标机不需要安装
Node、Bun、npm、pnpm 或 Git，也不会在安装时访问 package registry。bundle 不包含 Chromium、
账号、Cookie、browser profile、数据库、日志、凭据或平台内容；受支持的本机 Chrome 和用户自己的
登录态是 XHS 激活条件，不是 Kindred 基础安装条件。

## 验证与安装

先核对 release 页面提供的摘要，再解包：

```bash
shasum -a 256 -c kindred-xhs-sidecar-<version>-<target>.tar.gz.sha256
tar -xzf kindred-xhs-sidecar-<version>-<target>.tar.gz
cd kindred-xhs-sidecar-<version>-<target>
```

`manifest.json` 固定 source SHA、目标平台、Node/service API 版本及所有成员摘要。
`THIRD_PARTY_NOTICES.json` 与 `sbom.cdx.json` 用于许可和依赖审计。

发行包只提供三个窄 operator 命令：

```bash
# 可选：令服务从本机 0600 文件读取 bearer 等环境变量
export XHS_MCP_ENV_FILE=/absolute/path/to/xhs.env
export XHS_MCP_DATA_DIR=/absolute/path/to/life/state/xiaohongshu

./bin/kindred-xhs install-service
./bin/kindred-xhs status
./bin/kindred-xhs login
```

`install-service` 只注册当前 bundle 的 launchd 或 systemd-user 服务，不创建账号、不导入 Cookie，
也不安装浏览器。`status` 只通过 loopback health/MCP 返回服务版本和账号数量；`login` 交互式封装现有
二维码与必要的短信验证码流程。Bearer 只从环境或服务 env file 读取，不接受命令行 token。

本阶段没有通用 sidecar manager、账号管理 CLI、浏览器安装器、热更新或卸载数据逻辑。账号 DB、
profile 与日志始终留在 `XHS_MCP_DATA_DIR`，更新发行包不得覆盖它们。

## 从源码构建

两个 bundle 必须分别在目标平台原生构建；不得交叉复制 native module：

```bash
npm ci --ignore-scripts
npm rebuild better-sqlite3 canvas sharp
npm test
npm run build
python3 scripts/build-kindred-sidecar.py --target macos-arm64
# 或在 Ubuntu 24.04 x86_64：
python3 scripts/build-kindred-sidecar.py --target ubuntu-24.04-x86_64
```

构建器不会运行 root `postinstall`，因此不会下载 Chromium。GitHub 的
`Kindred XHS release` workflow 在两个目标 runner 上重复 native smoke、生成 SBOM、扫描源码历史与
release tree，并上传固定 artifacts。正式公开 tag 使用 `kindred-xhs-v<version>`。

平台页面协议可能变化，使用者应遵守当地法律与平台条款。Kindred 的 XHS 写侧仍默认
`write_mode=none`；安装 sidecar 不会自动开放发布、评论、点赞或收藏。
