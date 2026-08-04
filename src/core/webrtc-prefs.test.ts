/**
 * @fileoverview C8 webrtc-prefs 单测。
 * @module core/webrtc-prefs.test
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyWebRtcIpHandlingPolicy,
  readWebRtcIpHandlingPolicy,
  WEBRTC_POLICY_DISABLE_NON_PROXIED_UDP,
} from './webrtc-prefs.js';

describe('applyWebRtcIpHandlingPolicy', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-webrtc-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('写入 disable_non_proxied_udp', () => {
    applyWebRtcIpHandlingPolicy(dir);
    expect(readWebRtcIpHandlingPolicy(dir)).toBe(WEBRTC_POLICY_DISABLE_NON_PROXIED_UDP);
  });

  it('保留既有 Preferences 其他字段', () => {
    const defaultDir = path.join(dir, 'Default');
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.writeFileSync(
      path.join(defaultDir, 'Preferences'),
      JSON.stringify({ profile: { name: 'keep-me' }, webrtc: { udp_port_range: '1-2' } }),
    );
    applyWebRtcIpHandlingPolicy(dir);
    const prefs = JSON.parse(fs.readFileSync(path.join(defaultDir, 'Preferences'), 'utf8'));
    expect(prefs.profile.name).toBe('keep-me');
    expect(prefs.webrtc.udp_port_range).toBe('1-2');
    expect(prefs.webrtc.ip_handling_policy).toBe(WEBRTC_POLICY_DISABLE_NON_PROXIED_UDP);
  });

  it('幂等不破坏', () => {
    applyWebRtcIpHandlingPolicy(dir);
    applyWebRtcIpHandlingPolicy(dir);
    expect(readWebRtcIpHandlingPolicy(dir)).toBe(WEBRTC_POLICY_DISABLE_NON_PROXIED_UDP);
  });
});
