/**
 * @fileoverview 蓝军 #10 / #11 回归测试：batch 逐条鉴权、只读 fail-closed。
 * @module core/authorize.test
 */
import { describe, it, expect } from 'bun:test';
import { evaluateAuthorization, authorizeMessages, TOOL_CAPABILITIES } from './audit.js';

const FULL = 'full-secret';
const READONLY = 'ro-secret';
const BULK = 'bulk-secret';

describe('蓝军 #11 只读 fail-closed', () => {
  const base = {
    presentedToken: READONLY,
    bearerToken: FULL,
    bearerTokenReadonly: READONLY,
    bulkConfirmToken: '',
    confirmHeader: '',
  };

  it('未知/未分类工具对只读 token 一律 403', () => {
    const d = evaluateAuthorization({ ...base, tool: 'xhs_some_future_tool' });
    expect(d.ok).toBe(false);
    expect(d.httpStatus).toBe(403);
  });

  it('control 工具（停止浏览）对只读 token 放行', () => {
    const d = evaluateAuthorization({ ...base, tool: 'xhs_stop_explore' });
    expect(d.ok).toBe(true);
  });

  it('写工具对只读 token 403', () => {
    const d = evaluateAuthorization({ ...base, tool: 'xhs_like_feed' });
    expect(d.ok).toBe(false);
    expect(d.httpStatus).toBe(403);
  });

  it('读工具对只读 token 放行', () => {
    const d = evaluateAuthorization({ ...base, tool: 'xhs_get_note' });
    expect(d.ok).toBe(true);
  });

  it('能力登记表无非法分类值', () => {
    for (const cap of Object.values(TOOL_CAPABILITIES)) {
      expect(['read', 'write', 'control']).toContain(cap);
    }
  });
});

describe('蓝军 #10 JSON-RPC batch 鉴权', () => {
  const cfg = {
    bearerToken: FULL,
    bearerTokenReadonly: READONLY,
    bulkConfirmToken: BULK,
  };

  it('readonly token + batch 内含写工具 → 整批拒绝 (403)', () => {
    const d = authorizeMessages({
      presentedToken: READONLY,
      confirmHeader: '',
      ...cfg,
      messages: [
        { method: 'tools/call', params: { name: 'xhs_get_note', arguments: {} } },
        { method: 'tools/call', params: { name: 'xhs_post_comment', arguments: { accounts: 'all' } } },
      ],
    });
    expect(d.ok).toBe(false);
    expect(d.httpStatus).toBe(403);
  });

  it('readonly token + batch 全读/control → 放行', () => {
    const d = authorizeMessages({
      presentedToken: READONLY,
      confirmHeader: '',
      ...cfg,
      messages: [
        { method: 'tools/call', params: { name: 'xhs_get_note', arguments: {} } },
        { method: 'tools/call', params: { name: 'xhs_stop_explore', arguments: {} } },
      ],
    });
    expect(d.ok).toBe(true);
  });

  it('全量 token + batch 多账号写缺确认 → 整批拒绝 (403)', () => {
    const d = authorizeMessages({
      presentedToken: FULL,
      confirmHeader: '',
      ...cfg,
      messages: [{ method: 'tools/call', params: { name: 'xhs_post_comment', arguments: { accounts: 'all' } } }],
    });
    expect(d.ok).toBe(false);
  });

  it('全量 token + batch 多账号写带确认 → 放行', () => {
    const d = authorizeMessages({
      presentedToken: FULL,
      confirmHeader: BULK,
      ...cfg,
      messages: [{ method: 'tools/call', params: { name: 'xhs_post_comment', arguments: { accounts: 'all' } } }],
    });
    expect(d.ok).toBe(true);
  });
});
