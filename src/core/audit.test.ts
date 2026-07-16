/**
 * @fileoverview C3.3 本地 HTTP 鉴权/读写分级单元测试（离线）。
 * 覆盖 evaluateAuthorization 的 bearer / 只读 scope / 批量确认分支。
 * @module core/audit.test
 */
import { describe, it, expect } from 'bun:test';
import { evaluateAuthorization, WRITE_TOOL_NAMES } from './audit.js';

const FULL = 'full-secret';
const READONLY = 'readonly-secret';
const BULK = 'bulk-secret';

describe('C3.3 bearer 鉴权', () => {
  it('未配置 bearer 时一律放行', () => {
    const d = evaluateAuthorization({
      presentedToken: '',
      tool: 'xhs_post_comment',
      args: { accounts: 'all' },
      bearerToken: '',
      bearerTokenReadonly: '',
      bulkConfirmToken: '',
      confirmHeader: '',
    });
    expect(d.ok).toBe(true);
  });

  it('配置了 bearer 但缺失 token → 401', () => {
    const d = evaluateAuthorization({
      presentedToken: '',
      bearerToken: FULL,
      bearerTokenReadonly: '',
      bulkConfirmToken: '',
      confirmHeader: '',
    });
    expect(d.ok).toBe(false);
    expect(d.httpStatus).toBe(401);
  });

  it('配置了 bearer 但 token 错误 → 401', () => {
    const d = evaluateAuthorization({
      presentedToken: 'wrong',
      bearerToken: FULL,
      bearerTokenReadonly: '',
      bulkConfirmToken: '',
      confirmHeader: '',
    });
    expect(d.ok).toBe(false);
    expect(d.httpStatus).toBe(401);
  });

  it('全量 token 正确 → 写工具放行', () => {
    const d = evaluateAuthorization({
      presentedToken: FULL,
      tool: 'xhs_post_comment',
      args: {},
      bearerToken: FULL,
      bearerTokenReadonly: '',
      bulkConfirmToken: '',
      confirmHeader: '',
    });
    expect(d.ok).toBe(true);
  });
});

describe('C3.3 只读 scope 分级', () => {
  it('readonly token 调用写工具 → 403', () => {
    const d = evaluateAuthorization({
      presentedToken: READONLY,
      tool: 'xhs_like_feed',
      args: { accounts: 'acc1' },
      bearerToken: FULL,
      bearerTokenReadonly: READONLY,
      bulkConfirmToken: '',
      confirmHeader: '',
    });
    expect(d.ok).toBe(false);
    expect(d.httpStatus).toBe(403);
  });

  it('readonly token 调用读工具 → 放行', () => {
    const d = evaluateAuthorization({
      presentedToken: READONLY,
      tool: 'xhs_get_note',
      args: {},
      bearerToken: FULL,
      bearerTokenReadonly: READONLY,
      bulkConfirmToken: '',
      confirmHeader: '',
    });
    expect(d.ok).toBe(true);
  });

  it('readonly token 与全量 token 相同（误配）→ 视为全量，写工具放行', () => {
    const d = evaluateAuthorization({
      presentedToken: FULL,
      tool: 'xhs_post_comment',
      args: {},
      bearerToken: FULL,
      bearerTokenReadonly: FULL,
      bulkConfirmToken: '',
      confirmHeader: '',
    });
    expect(d.ok).toBe(true);
  });
});

describe('C3.3 批量写确认', () => {
  it('多账号写缺确认头 → 403', () => {
    const d = evaluateAuthorization({
      presentedToken: FULL,
      tool: 'xhs_post_comment',
      args: { accounts: 'all' },
      bearerToken: FULL,
      bearerTokenReadonly: '',
      bulkConfirmToken: BULK,
      confirmHeader: '',
    });
    expect(d.ok).toBe(false);
    expect(d.httpStatus).toBe(403);
  });

  it('多账号写（数组>1）缺确认头 → 403', () => {
    const d = evaluateAuthorization({
      presentedToken: FULL,
      tool: 'xhs_post_comment',
      args: { accounts: ['a', 'b'] },
      bearerToken: FULL,
      bearerTokenReadonly: '',
      bulkConfirmToken: BULK,
      confirmHeader: 'nope',
    });
    expect(d.ok).toBe(false);
  });

  it('多账号写确认头匹配 → 放行', () => {
    const d = evaluateAuthorization({
      presentedToken: FULL,
      tool: 'xhs_post_comment',
      args: { accounts: 'all' },
      bearerToken: FULL,
      bearerTokenReadonly: '',
      bulkConfirmToken: BULK,
      confirmHeader: BULK,
    });
    expect(d.ok).toBe(true);
  });

  it('单账号写即使配了 bulkConfirm 也不强制确认 → 放行', () => {
    const d = evaluateAuthorization({
      presentedToken: FULL,
      tool: 'xhs_post_comment',
      args: { accounts: 'acc1' },
      bearerToken: FULL,
      bearerTokenReadonly: '',
      bulkConfirmToken: BULK,
      confirmHeader: '',
    });
    expect(d.ok).toBe(true);
  });

  it('未配置 bulkConfirm → 多账号写直接放行', () => {
    const d = evaluateAuthorization({
      presentedToken: FULL,
      tool: 'xhs_post_comment',
      args: { accounts: 'all' },
      bearerToken: FULL,
      bearerTokenReadonly: '',
      bulkConfirmToken: '',
      confirmHeader: '',
    });
    expect(d.ok).toBe(true);
  });
});

describe('C3.3 写工具集合', () => {
  it('包含关键写工具、不含关键读工具', () => {
    expect(WRITE_TOOL_NAMES.has('xhs_post_comment')).toBe(true);
    expect(WRITE_TOOL_NAMES.has('xhs_publish_draft')).toBe(true);
    expect(WRITE_TOOL_NAMES.has('xhs_search')).toBe(false);
    expect(WRITE_TOOL_NAMES.has('xhs_get_note')).toBe(false);
  });
});
