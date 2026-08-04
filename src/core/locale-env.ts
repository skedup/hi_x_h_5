/**
 * @fileoverview C3：账号时区 / locale / geolocation 校验与 Playwright 启动选项组装。
 * 禁止无属地时瞎填 geo；不默认伪造 UA。
 * @module core/locale-env
 */

import { createLogger } from './logger.js';

const log = createLogger('locale-env');

/** 账号浏览器属地环境（C3） */
export interface AccountLocaleEnv {
  /** IANA 时区，如 Asia/Shanghai */
  timezoneId?: string;
  /** BCP-47 locale，如 zh-CN（驱动 Playwright locale → languages / Accept-Language） */
  locale?: string;
  /** 地理坐标；须与 timezone + locale 同时配置 */
  geolocation?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
}

/** Playwright launchPersistentContext 可用的属地片段 */
export interface PlaywrightLocaleLaunchOptions {
  timezoneId?: string;
  locale?: string;
  geolocation?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
}

const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/**
 * 校验 IANA 时区是否可被 Intl 识别。
 */
export function isValidTimezoneId(timezoneId: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezoneId });
    return true;
  } catch {
    return false;
  }
}

/**
 * 校验 BCP-47 风格 locale（宽松）。
 */
export function isValidLocale(locale: string): boolean {
  return LOCALE_RE.test(locale.trim());
}

/**
 * 规范化并校验 AccountLocaleEnv。
 * - geo 必须同时带 timezoneId + locale（禁止瞎填）
 * - 非法字段 → error
 */
export function validateAccountLocaleEnv(
  input: AccountLocaleEnv,
): { ok: true; value: AccountLocaleEnv } | { ok: false; error: string } {
  const out: AccountLocaleEnv = {};

  if (input.timezoneId !== undefined) {
    const tz = input.timezoneId.trim();
    if (!tz) {
      // 空串视为清除
    } else if (!isValidTimezoneId(tz)) {
      return { ok: false, error: `invalid timezoneId: ${tz}` };
    } else {
      out.timezoneId = tz;
    }
  }

  if (input.locale !== undefined) {
    const loc = input.locale.trim();
    if (!loc) {
      // 清除
    } else if (!isValidLocale(loc)) {
      return { ok: false, error: `invalid locale: ${loc}` };
    } else {
      out.locale = loc;
    }
  }

  if (input.geolocation !== undefined) {
    const { latitude, longitude, accuracy } = input.geolocation;
    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      return { ok: false, error: 'geolocation requires finite numeric latitude and longitude' };
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return { ok: false, error: 'geolocation latitude/longitude out of range' };
    }
    if (
      accuracy !== undefined &&
      (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0)
    ) {
      return { ok: false, error: 'geolocation accuracy must be a non-negative finite number' };
    }
    out.geolocation = {
      latitude,
      longitude,
      ...(accuracy !== undefined ? { accuracy } : {}),
    };
  }

  if (out.geolocation && (!out.timezoneId || !out.locale)) {
    return {
      ok: false,
      error: 'geolocation requires both timezoneId and locale (forbid blind geo fill)',
    };
  }

  return { ok: true, value: out };
}

/**
 * 合并「已有账号环境」与「本次更新」再校验（用于 set_account_config 部分更新）。
 * 更新字段为 `null` 表示清除；`undefined` 表示不改。
 */
export function mergeAccountLocaleEnv(
  current: AccountLocaleEnv,
  patch: {
    timezoneId?: string | null;
    locale?: string | null;
    geolocation?: AccountLocaleEnv['geolocation'] | null;
  },
): { ok: true; value: AccountLocaleEnv } | { ok: false; error: string } {
  const merged: AccountLocaleEnv = { ...current };

  if (patch.timezoneId === null) delete merged.timezoneId;
  else if (typeof patch.timezoneId === 'string') merged.timezoneId = patch.timezoneId;

  if (patch.locale === null) delete merged.locale;
  else if (typeof patch.locale === 'string') merged.locale = patch.locale;

  if (patch.geolocation === null) delete merged.geolocation;
  else if (patch.geolocation !== undefined) merged.geolocation = patch.geolocation;

  return validateAccountLocaleEnv(merged);
}

/**
 * 组装 Playwright 启动选项（仅包含已配置项）。
 */
export function buildPlaywrightLocaleOptions(env: AccountLocaleEnv): PlaywrightLocaleLaunchOptions {
  const validated = validateAccountLocaleEnv(env);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  const v = validated.value;
  const out: PlaywrightLocaleLaunchOptions = {};
  if (v.timezoneId) out.timezoneId = v.timezoneId;
  if (v.locale) out.locale = v.locale;
  if (v.geolocation && v.timezoneId && v.locale) {
    out.geolocation = { ...v.geolocation };
  }
  return out;
}

/**
 * A1+C3：有 proxy 却无时区/locale 时告警（不默认瞎填）。
 */
export function warnIfProxyWithoutLocale(proxy: string | undefined, env: AccountLocaleEnv): void {
  if (!proxy?.trim()) return;
  if (env.timezoneId && env.locale) return;
  log.warn('账号已配置 proxy 但缺少 timezoneId/locale（C3）；建议 set_account_config 补齐属地', {
    hasTimezone: !!env.timezoneId,
    hasLocale: !!env.locale,
    hasGeo: !!env.geolocation,
  });
}

/**
 * 序列化 geolocation 落库。
 */
export function serializeGeolocation(geo: AccountLocaleEnv['geolocation'] | undefined): string | null {
  if (!geo) return null;
  return JSON.stringify(geo);
}

/**
 * 反序列化 geolocation。
 */
export function parseGeolocationJson(raw: string | null | undefined): AccountLocaleEnv['geolocation'] | undefined {
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw);
    if (
      typeof o?.latitude === 'number' &&
      typeof o?.longitude === 'number' &&
      Number.isFinite(o.latitude) &&
      Number.isFinite(o.longitude)
    ) {
      return {
        latitude: o.latitude,
        longitude: o.longitude,
        ...(typeof o.accuracy === 'number' && Number.isFinite(o.accuracy) ? { accuracy: o.accuracy } : {}),
      };
    }
  } catch {
    /* ignore */
  }
  return undefined;
}
