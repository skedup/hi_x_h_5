/**
 * @fileoverview 账号代理配置解析与多账号出口门禁（蓝军 A1）。
 * 支持 URL（含 user:pass）与 JSON；serverKey 用于批次内互异校验。
 * @module core/proxy
 */

import { createLogger } from './logger.js';

const log = createLogger('proxy');

/** 多账号写批次代理硬约束模式 */
export type ProxyRequiredMode = 'off' | 'warn' | 'block';

/** 解析后的 Playwright 可用代理 */
export interface ParsedProxy {
  /** 形如 http://host:8080（不含凭证） */
  server: string;
  username?: string;
  password?: string;
  /** 规范化互异键：hostname:port（小写） */
  serverKey: string;
}

/**
 * 解析 XHS_MCP_AD_PROXY_REQUIRED。
 * 默认 block（多账号写强制互异代理）；warn 仅告警；off/false 关闭。
 */
export function parseProxyRequiredMode(value: string | undefined): ProxyRequiredMode {
  if (value === undefined) return 'block';
  const v = value.toLowerCase().trim();
  if (['false', '0', 'off', 'no'].includes(v)) return 'off';
  if (['warn', 'warning'].includes(v)) return 'warn';
  if (['true', '1', 'on', 'yes', 'block'].includes(v)) return 'block';
  return 'block';
}

function defaultPort(protocol: string): string {
  const p = protocol.replace(/:$/, '').toLowerCase();
  if (p === 'https') return '443';
  if (p === 'socks5' || p === 'socks5h' || p === 'socks4') return '1080';
  return '80';
}

function buildServerKey(hostname: string, port: string): string {
  return `${hostname.toLowerCase()}:${port}`;
}

function fromUrl(url: URL): ParsedProxy {
  const port = url.port || defaultPort(url.protocol);
  const server = `${url.protocol}//${url.hostname}:${port}`;
  const parsed: ParsedProxy = {
    server,
    serverKey: buildServerKey(url.hostname, port),
  };
  if (url.username) {
    parsed.username = decodeURIComponent(url.username);
  }
  if (url.password) {
    parsed.password = decodeURIComponent(url.password);
  }
  return parsed;
}

/**
 * 将账号 proxy 字段解析为 Playwright 形态。
 * 支持：
 * - `http://host:8080`
 * - `http://user:pass@host:8080`
 * - `socks5://host:1080`
 * - JSON：`{"server":"http://host:8080","username":"u","password":"p"}`
 * 空 / 无效 → null。
 */
export function parseProxyConfig(raw: string | null | undefined): ParsedProxy | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim();
  if (!s) return null;

  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s) as {
        server?: unknown;
        username?: unknown;
        password?: unknown;
      };
      if (typeof obj.server !== 'string' || !obj.server.trim()) return null;
      const inner = parseProxyConfig(obj.server);
      if (!inner) return null;
      if (typeof obj.username === 'string' && obj.username) {
        inner.username = obj.username;
      }
      if (typeof obj.password === 'string' && obj.password) {
        inner.password = obj.password;
      }
      return inner;
    } catch {
      return null;
    }
  }

  try {
    const withScheme = s.includes('://') ? s : `http://${s}`;
    const url = new URL(withScheme);
    if (!url.hostname) return null;
    return fromUrl(url);
  } catch {
    return null;
  }
}

/** 转为 patchright/playwright launch 的 proxy 选项 */
export function toPlaywrightProxy(parsed: ParsedProxy): {
  server: string;
  username?: string;
  password?: string;
} {
  const out: { server: string; username?: string; password?: string } = {
    server: parsed.server,
  };
  if (parsed.username !== undefined) out.username = parsed.username;
  if (parsed.password !== undefined) out.password = parsed.password;
  return out;
}

/** 校验用户输入的 proxy 字符串；空串表示清除，视为合法 */
export function validateProxyInput(raw: string): { ok: true } | { ok: false; error: string } {
  if (!raw.trim()) return { ok: true };
  if (!parseProxyConfig(raw)) {
    return {
      ok: false,
      error:
        'Invalid proxy. Use http://host:port, http://user:pass@host:port, or JSON {"server":"http://host:port","username":"...","password":"..."}',
    };
  }
  return { ok: true };
}

export interface ProxyGateAccount {
  name: string;
  proxy?: string | null;
}

export interface ProxyGateSkip {
  account: string;
  reason: 'proxy_required' | 'proxy_shared' | 'proxy_invalid';
}

/**
 * 多账号写批次出口门禁（A1）。
 * - off：不检查
 * - warn：缺代理/同 server/非法仅打日志，不跳过
 * - block：缺代理 → proxy_required；非法 → proxy_invalid；同 serverKey 后者 → proxy_shared
 * 单账号批次（length≤1）调用方不应使用本函数（计划：单账号写默认允许无 proxy）。
 */
export function evaluateMultiAccountProxyGate(
  accounts: ProxyGateAccount[],
  mode: ProxyRequiredMode,
): { skips: ProxyGateSkip[]; warnings: string[] } {
  const skips: ProxyGateSkip[] = [];
  const warnings: string[] = [];
  if (mode === 'off' || accounts.length <= 1) {
    return { skips, warnings };
  }

  const seen = new Map<string, string>(); // serverKey → first account name

  for (const acc of accounts) {
    const parsed = parseProxyConfig(acc.proxy ?? undefined);
    if (!acc.proxy?.trim()) {
      const msg = `账号 ${acc.name} 缺少 proxy（多账号写要求互异出口）`;
      if (mode === 'block') {
        skips.push({ account: acc.name, reason: 'proxy_required' });
      } else {
        warnings.push(msg);
        log.warn(msg);
      }
      continue;
    }
    if (!parsed) {
      const msg = `账号 ${acc.name} proxy 无法解析`;
      if (mode === 'block') {
        skips.push({ account: acc.name, reason: 'proxy_invalid' });
      } else {
        warnings.push(msg);
        log.warn(msg);
      }
      continue;
    }
    const owner = seen.get(parsed.serverKey);
    if (owner) {
      const msg = `账号 ${acc.name} 与 ${owner} 共享 proxy serverKey=${parsed.serverKey}`;
      if (mode === 'block') {
        skips.push({ account: acc.name, reason: 'proxy_shared' });
      } else {
        warnings.push(msg);
        log.warn(msg);
      }
      continue;
    }
    seen.set(parsed.serverKey, acc.name);
  }

  return { skips, warnings };
}
