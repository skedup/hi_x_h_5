/**
 * @fileoverview C8：Chrome 持久化 profile 写入 WebRTC IP 处理策略，降低代理下 ICE 宿主 IP 泄漏。
 * 使用 Preferences `webrtc.ip_handling_policy=disable_non_proxied_udp`（非 stub RTCPeerConnection）。
 * @module core/webrtc-prefs
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from './logger.js';

const log = createLogger('webrtc-prefs');

/** Chrome Preferences 键 */
export const WEBRTC_IP_HANDLING_PREF = 'webrtc.ip_handling_policy';

/** 禁用非代理 UDP ICE（经代理时优先） */
export const WEBRTC_POLICY_DISABLE_NON_PROXIED_UDP = 'disable_non_proxied_udp';

/**
 * 在 launchPersistentContext 之前，向 user-data-dir 写入 WebRTC IP 策略。
 * 幂等：已是目标值则跳过写盘。
 */
export function applyWebRtcIpHandlingPolicy(
  profileDir: string,
  policy: string = WEBRTC_POLICY_DISABLE_NON_PROXIED_UDP,
): void {
  const defaultDir = path.join(profileDir, 'Default');
  const prefsPath = path.join(defaultDir, 'Preferences');

  fs.mkdirSync(defaultDir, { recursive: true });

  let prefs: Record<string, unknown> = {};
  if (fs.existsSync(prefsPath)) {
    try {
      const raw = fs.readFileSync(prefsPath, 'utf8');
      prefs = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      log.warn('读取 Preferences 失败，将重建 webrtc 相关字段', {
        prefsPath,
        error: err instanceof Error ? err.message : String(err),
      });
      prefs = {};
    }
  }

  let webrtc = prefs.webrtc;
  if (!webrtc || typeof webrtc !== 'object' || Array.isArray(webrtc)) {
    webrtc = {};
  }
  const webrtcObj = webrtc as Record<string, unknown>;
  if (webrtcObj.ip_handling_policy === policy) {
    return;
  }

  webrtcObj.ip_handling_policy = policy;
  prefs.webrtc = webrtcObj;

  const tmp = `${prefsPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(prefs), 'utf8');
  fs.renameSync(tmp, prefsPath);
  log.info('已写入 WebRTC IP 处理策略', { policy, profileDir: path.basename(profileDir) });
}

/**
 * 读取 profile 中当前 webrtc.ip_handling_policy（测辅 / 自检）。
 */
export function readWebRtcIpHandlingPolicy(profileDir: string): string | undefined {
  const prefsPath = path.join(profileDir, 'Default', 'Preferences');
  if (!fs.existsSync(prefsPath)) return undefined;
  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')) as {
      webrtc?: { ip_handling_policy?: string };
    };
    return prefs.webrtc?.ip_handling_policy;
  } catch {
    return undefined;
  }
}
