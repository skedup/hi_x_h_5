/**
 * @fileoverview 账号会话下载出口（Cookie + proxy + Referer/Sec-Fetch）。
 * 发布配图与笔记下载共用，禁止业务路径 Node 裸 fetch 旁路。
 * @module core/account-download
 */

import fs from 'fs-extra';
import path from 'path';
import https from 'https';
import http from 'http';
import type { APIRequestContext } from 'patchright';

/**
 * 解析 URL（失败返回 null，避免崩溃）。
 */
export function tryParseUrl(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

/**
 * 推导 URL 与小红书主站的站点关系，用于生成一致的 Sec-Fetch-Site（蓝军 #8 / R2-8）。
 * 浏览器页面固定在 www.xiaohongshu.com，据此判定：
 * - 'same-origin'：仅 www.xiaohongshu.com 本身（与页面同源）；
 * - 'same-site'：同注册域其它主机（如 xiaohongshu.com 裸域、sns.xiaohongshu.com 等子域），但非同源；
 * - 'cross-site'：其它注册域（如 sns-img.xhscdn.com 等 CDN），绝不可自称 same-origin。
 */
export function classifyXhsSite(u: URL): 'same-origin' | 'same-site' | 'cross-site' {
  if (u.hostname === 'www.xiaohongshu.com') return 'same-origin';
  if (u.hostname === 'xiaohongshu.com' || u.hostname.endsWith('.xiaohongshu.com')) return 'same-site';
  return 'cross-site';
}

/**
 * 账号相关下载复用同一浏览器会话的 APIRequestContext，
 * 自动携带该账号的 Cookie 与代理出口，并补齐与最终 URL 一致的 Referer/Sec-Fetch 头，
 * 使下载请求与页面请求在 egress IP / Cookie / 会话头上一致。
 *
 * 提供了 apiRequest 时走它；否则回退到普通 http/https 直连（仅无账号会话时的兜底，
 * 发布配图等业务路径不得依赖此回退——见 resolveImagePaths fail-closed）。
 *
 * @param url - 源 URL
 * @param destPath - 目标文件路径
 * @param apiRequest - 账号浏览器上下文的 APIRequestContext（可能为 null）
 * @param options.resourceType - 资源类型，决定 Sec-Fetch-Dest（视频不能自称 image）
 * @param options.headers - 额外请求头（覆盖默认 Sec-Fetch 等）
 */
export async function downloadFile(
  url: string,
  destPath: string,
  apiRequest?: APIRequestContext | null,
  options: { resourceType?: 'image' | 'video'; headers?: Record<string, string> } = {},
): Promise<{ size: number }> {
  const { resourceType = 'image', headers = {} } = options;
  await fs.ensureDir(path.dirname(destPath));

  if (apiRequest) {
    const parsed = tryParseUrl(url);
    const site = parsed ? classifyXhsSite(parsed) : 'cross-site';
    const dest = resourceType === 'video' ? 'video' : 'image';
    const resp = await apiRequest.get(url, {
      headers: {
        Referer: 'https://www.xiaohongshu.com/',
        'Sec-Fetch-Site': site,
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Dest': dest,
        ...headers,
      },
    });
    if (!resp.ok()) {
      throw new Error(`HTTP ${resp.status()}`);
    }
    const buf = Buffer.from(await resp.body());
    await fs.writeFile(destPath, buf);
    return { size: buf.length };
  }

  // 回退：无账号会话时走普通 http/https（保留原行为，含重定向跟随）
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
          return;
        }
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(destPath);
      let size = 0;

      response.on('data', (chunk) => {
        size += chunk.length;
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve({ size });
      });

      file.on('error', (err) => {
        fs.unlink(destPath).catch(() => {});
        reject(err);
      });
    });

    request.on('error', (err) => {
      reject(err);
    });

    request.setTimeout(60000, () => {
      request.destroy();
      reject(new Error('Download timeout'));
    });
  });
}
