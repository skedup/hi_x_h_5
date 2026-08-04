# C8 · WebRTC / ICE 本地 IP 缓解

**状态**：done（`feat/blue-c3-c8`）

## 问题

代理浏览时 WebRTC STUN 仍可能暴露宿主公网/局域网 IP，与 egress 不一致（01 P0-4）。

## 方案

有 **可解析 proxy** 且 `XHS_MCP_AD_WEBRTC_MITIGATION` 未关闭时，在 `launchPersistentContext` **之前**向 profile 写入 Chrome Preferences：

```json
{ "webrtc": { "ip_handling_policy": "disable_non_proxied_udp" } }
```

- **不做** `RTCPeerConnection` initScript stub（易成异常指纹）
- **不做** 默认 `--disable-webrtc`
- 无 proxy 时不改 prefs（本机直连场景）

回滚：`XHS_MCP_AD_WEBRTC_MITIGATION=false`

## 模块

- `src/core/webrtc-prefs.ts` — `applyWebRtcIpHandlingPolicy` / `readWebRtcIpHandlingPolicy`
- `src/xhs/clients/context.ts` — 有 proxy 时调用

## 自检清单（01 §5 / 手工）

1. 账号配置认证 proxy + 开启缓解（默认开）
2. 启动后打开任意页，DevTools Console：

```js
const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
pc.createDataChannel('x');
pc.onicecandidate = (e) => console.log(e.candidate && e.candidate.candidate);
pc.createOffer().then((o) => pc.setLocalDescription(o));
```

3. 候选中不应出现宿主局域网 RFC1918，也不应稳定出现与代理 egress 无关的宿主公网 IP  
4. 若当前 Chrome/channel 下 prefs 未生效：记入威胁模型（仅信任切断 UDP/STUN 的代理），可 `wontfix` 该路径并保持 env 开关

## 验证

```bash
bun test src/core/webrtc-prefs.test.ts
```

## DoD

- [x] prefs 写入 + 幂等 + 保留其他 Preferences 字段
- [x] env 可关
- [x] 文档自检步骤
- [x] 与 A1 proxy 捆绑（仅 proxy 会话启用）
