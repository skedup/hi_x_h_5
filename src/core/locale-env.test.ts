/**
 * @fileoverview C3 locale-env 单测。
 * @module core/locale-env.test
 */
import { describe, it, expect } from 'bun:test';
import {
  buildPlaywrightLocaleOptions,
  isValidTimezoneId,
  mergeAccountLocaleEnv,
  validateAccountLocaleEnv,
} from './locale-env.js';

describe('isValidTimezoneId', () => {
  it('接受常见 IANA', () => {
    expect(isValidTimezoneId('Asia/Shanghai')).toBe(true);
    expect(isValidTimezoneId('America/New_York')).toBe(true);
  });
  it('拒绝非法', () => {
    expect(isValidTimezoneId('Not/AZone')).toBe(false);
  });
});

describe('validateAccountLocaleEnv', () => {
  it('timezone / locale 可单独配置', () => {
    expect(validateAccountLocaleEnv({ timezoneId: 'Asia/Shanghai' }).ok).toBe(true);
    expect(validateAccountLocaleEnv({ locale: 'zh-CN' }).ok).toBe(true);
  });

  it('geo 无 timezone/locale 被拒', () => {
    const r = validateAccountLocaleEnv({
      geolocation: { latitude: 31.2, longitude: 121.5 },
    });
    expect(r.ok).toBe(false);
  });

  it('geo + timezone + locale 通过', () => {
    const r = validateAccountLocaleEnv({
      timezoneId: 'Asia/Shanghai',
      locale: 'zh-CN',
      geolocation: { latitude: 31.2, longitude: 121.5, accuracy: 100 },
    });
    expect(r.ok).toBe(true);
  });
});

describe('buildPlaywrightLocaleOptions', () => {
  it('仅输出已配置键', () => {
    expect(buildPlaywrightLocaleOptions({ timezoneId: 'Asia/Shanghai' })).toEqual({
      timezoneId: 'Asia/Shanghai',
    });
    expect(
      buildPlaywrightLocaleOptions({
        timezoneId: 'Asia/Shanghai',
        locale: 'zh-CN',
        geolocation: { latitude: 1, longitude: 2 },
      }),
    ).toEqual({
      timezoneId: 'Asia/Shanghai',
      locale: 'zh-CN',
      geolocation: { latitude: 1, longitude: 2 },
    });
  });

  it('有 geo 但缺 locale 时不输出 geo（validate 已拒）', () => {
    expect(() =>
      buildPlaywrightLocaleOptions({
        timezoneId: 'Asia/Shanghai',
        geolocation: { latitude: 1, longitude: 2 },
      }),
    ).toThrow(/geolocation requires/);
  });
});

describe('mergeAccountLocaleEnv', () => {
  it('部分更新保留原值；null 清除', () => {
    const cur = {
      timezoneId: 'Asia/Shanghai',
      locale: 'zh-CN',
      geolocation: { latitude: 31, longitude: 121 },
    };
    const cleared = mergeAccountLocaleEnv(cur, { geolocation: null });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.value.geolocation).toBeUndefined();
      expect(cleared.value.timezoneId).toBe('Asia/Shanghai');
    }
  });
});
