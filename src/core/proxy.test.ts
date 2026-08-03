/**
 * @fileoverview A1 代理解析与多账号出口门禁单测。
 * @module core/proxy.test
 */
import { describe, it, expect } from 'bun:test';
import {
  parseProxyConfig,
  parseProxyRequiredMode,
  toPlaywrightProxy,
  validateProxyInput,
  evaluateMultiAccountProxyGate,
} from './proxy.js';

describe('parseProxyRequiredMode', () => {
  it('默认 block', () => {
    expect(parseProxyRequiredMode(undefined)).toBe('block');
  });

  it('解析 off/warn/block 别名', () => {
    expect(parseProxyRequiredMode('off')).toBe('off');
    expect(parseProxyRequiredMode('false')).toBe('off');
    expect(parseProxyRequiredMode('warn')).toBe('warn');
    expect(parseProxyRequiredMode('true')).toBe('block');
    expect(parseProxyRequiredMode('block')).toBe('block');
  });
});

describe('parseProxyConfig', () => {
  it('解析带认证的 URL', () => {
    const p = parseProxyConfig('http://user:p%40ss@proxy.example:8080');
    expect(p).not.toBeNull();
    expect(p!.server).toBe('http://proxy.example:8080');
    expect(p!.username).toBe('user');
    expect(p!.password).toBe('p@ss');
    expect(p!.serverKey).toBe('proxy.example:8080');
  });

  it('解析 JSON server + 凭证', () => {
    const p = parseProxyConfig(
      JSON.stringify({
        server: 'http://1.2.3.4:3128',
        username: 'u',
        password: 'p',
      }),
    );
    expect(p!.serverKey).toBe('1.2.3.4:3128');
    expect(p!.username).toBe('u');
    expect(toPlaywrightProxy(p!)).toEqual({
      server: 'http://1.2.3.4:3128',
      username: 'u',
      password: 'p',
    });
  });

  it('空与非法返回 null', () => {
    expect(parseProxyConfig('')).toBeNull();
    expect(parseProxyConfig('   ')).toBeNull();
    expect(parseProxyConfig('{not-json')).toBeNull();
    expect(parseProxyConfig(JSON.stringify({ server: '' }))).toBeNull();
  });

  it('无 scheme 默认 http', () => {
    const p = parseProxyConfig('host.local:9000');
    expect(p!.server).toBe('http://host.local:9000');
    expect(p!.serverKey).toBe('host.local:9000');
  });
});

describe('validateProxyInput', () => {
  it('空串允许（清除 proxy）', () => {
    expect(validateProxyInput('').ok).toBe(true);
    expect(validateProxyInput('  ').ok).toBe(true);
  });

  it('非法拒绝', () => {
    const r = validateProxyInput('http://');
    expect(r.ok).toBe(false);
  });
});

describe('evaluateMultiAccountProxyGate', () => {
  it('off 与单账号不检查', () => {
    expect(
      evaluateMultiAccountProxyGate([{ name: 'a', proxy: null }], 'block').skips,
    ).toEqual([]);
    expect(
      evaluateMultiAccountProxyGate(
        [
          { name: 'a', proxy: null },
          { name: 'b', proxy: null },
        ],
        'off',
      ).skips,
    ).toEqual([]);
  });

  it('block：缺 proxy / 同 server / 非法', () => {
    const { skips } = evaluateMultiAccountProxyGate(
      [
        { name: 'a', proxy: 'http://p1:1' },
        { name: 'b', proxy: null },
        { name: 'c', proxy: 'http://p1:1' },
        { name: 'd', proxy: '{bad' },
        { name: 'e', proxy: 'http://p2:2' },
      ],
      'block',
    );
    expect(skips).toEqual([
      { account: 'b', reason: 'proxy_required' },
      { account: 'c', reason: 'proxy_shared' },
      { account: 'd', reason: 'proxy_invalid' },
    ]);
  });

  it('warn：告警不 skip', () => {
    const { skips, warnings } = evaluateMultiAccountProxyGate(
      [
        { name: 'a', proxy: null },
        { name: 'b', proxy: 'http://same:1' },
        { name: 'c', proxy: 'http://same:1' },
      ],
      'warn',
    );
    expect(skips).toEqual([]);
    expect(warnings.length).toBe(2);
  });

  it('同 host 不同 port 视为互异', () => {
    const { skips } = evaluateMultiAccountProxyGate(
      [
        { name: 'a', proxy: 'http://p:1' },
        { name: 'b', proxy: 'http://p:2' },
      ],
      'block',
    );
    expect(skips).toEqual([]);
  });
});
