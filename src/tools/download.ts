/**
 * @fileoverview MCP tool definitions and handlers for downloading media.
 * Provides tools for downloading images and videos from notes.
 * @module tools/download
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import fs from 'fs-extra';
import path from 'path';
import https from 'https';
import http from 'http';
import type { APIRequestContext } from 'patchright';
import { AccountPool } from '../core/account-pool.js';
import { XhsDatabase } from '../db/index.js';
import { getImageDownloadPath, getVideoDownloadPath } from '../core/paths.js';
import { executeWithMultipleAccounts, MultiAccountParams } from '../core/multi-account.js';
import { getCooccurrenceGuard } from '../core/antidetect.js';

/**
 * Download tool definitions for MCP.
 */
export const downloadTools: Tool[] = [
  {
    name: 'xhs_download_images',
    description: 'Download all images from a note to local storage.',
    inputSchema: {
      type: 'object',
      properties: {
        noteId: {
          type: 'string',
          description: 'Note ID to download images from',
        },
        xsecToken: {
          type: 'string',
          description: 'Security token from search results',
        },
        account: {
          type: 'string',
          description: 'Account name or ID to use for fetching note details',
        },
      },
      required: ['noteId', 'xsecToken'],
    },
  },
  {
    name: 'xhs_download_video',
    description: 'Download video from a note to local storage.',
    inputSchema: {
      type: 'object',
      properties: {
        noteId: {
          type: 'string',
          description: 'Note ID to download video from',
        },
        xsecToken: {
          type: 'string',
          description: 'Security token from search results',
        },
        account: {
          type: 'string',
          description: 'Account name or ID to use for fetching note details',
        },
      },
      required: ['noteId', 'xsecToken'],
    },
  },
];

/**
 * 解析 URL（失败返回 null，避免崩溃）。
 */
function tryParseUrl(u: string): URL | null {
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
function classifyXhsSite(u: URL): 'same-origin' | 'same-site' | 'cross-site' {
  if (u.hostname === 'www.xiaohongshu.com') return 'same-origin';
  if (u.hostname === 'xiaohongshu.com' || u.hostname.endsWith('.xiaohongshu.com')) return 'same-site';
  return 'cross-site';
}

/**
 * B2（04 §6）下载出口统一：账号相关下载复用同一浏览器会话的 APIRequestContext，
 * 自动携带该账号的 Cookie 与代理出口，并补齐与最终 URL 一致的 Referer/Sec-Fetch 头，
 * 使下载请求与页面请求在 egress IP / Cookie / 会话头上一致，消除 Node fetch 直连的无头特征。
 *
 * 提供了 apiRequest 时走它；否则回退到普通 http/https 直连（保留无账号会话时的原行为）。
 *
 * @param url - 源 URL
 * @param destPath - 目标文件路径
 * @param apiRequest - 账号浏览器上下文的 APIRequestContext（可能为 null）
 * @param options.resourceType - 资源类型，决定 Sec-Fetch-Dest（蓝军 #8：视频不能自称 image）
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
    // 按最终 URL 推导一致的 Fetch Metadata（蓝军 #8：跨站 CDN 不能自称 same-origin，视频不能自称 image）
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
        // Follow redirect
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

/**
 * Handle download tool calls.
 *
 * @param name - Tool name
 * @param args - Tool arguments
 * @param pool - Account pool instance
 * @param db - Database instance
 * @returns MCP tool response
 */
export async function handleDownloadTools(name: string, args: any, pool: AccountPool, db: XhsDatabase) {
  switch (name) {
    case 'xhs_download_images': {
      const params = z
        .object({
          noteId: z.string(),
          xsecToken: z.string(),
          account: z.string().optional(),
        })
        .parse(args);

      let apiRequest: APIRequestContext | null = null;
      const multiParams: MultiAccountParams = { account: params.account };

      // 先取笔记详情（触发浏览器 context 初始化），再读取 request（蓝军 #9 冷启动修复）
      const results = await executeWithMultipleAccounts(pool, db, multiParams, 'get_note_for_download', async (ctx) => {
        // R4 P1 1019912496：来源校验必须在发请求前完成（fail-closed），
        // 否则未知/跨账号 token 已随 getNote 发出，校验 throw 无法阻止泄露。
        const chk = getCooccurrenceGuard().checkXsecSource(params.xsecToken, ctx.accountId);
        if (!chk.allow) throw new Error(`xsec token 校验失败（${chk.reason}）：消费路径不得补写来源`);
        const note = await ctx.client.getNote(params.noteId, params.xsecToken);
        apiRequest = ctx.client.request;
        return note;
      }, { capability: 'read' });

      const r = results[0];
      if (!r.success || !r.result) {
        return {
          content: [{ type: 'text', text: `Failed to get note: ${r.error || 'Note not found'}` }],
          isError: true,
        };
      }

      // 蓝军 #6：xsecToken 来源绑定已在上面的提取回调（ctx.accountId）内完成（fail-closed）

      // 蓝军 #9 冷启动出口保护：指定账号但浏览器 context 仍未初始化时，禁止回退直连（fail-closed）
      if (params.account && !apiRequest) {
        return {
          content: [
            {
              type: 'text',
              text: `Account egress unavailable: browser context not initialized for account "${params.account}". Refusing direct download to protect egress consistency.`,
            },
          ],
          isError: true,
        };
      }

      const note = r.result;
      if (!note.imageList || note.imageList.length === 0) {
        return {
          content: [{ type: 'text', text: 'No images found in this note' }],
          isError: true,
        };
      }

      // Download images
      const downloadDir = getImageDownloadPath(params.noteId);
      await fs.ensureDir(downloadDir);

      const downloaded: { filename: string; size: number; url: string }[] = [];
      const errors: { index: number; error: string }[] = [];

      for (let i = 0; i < note.imageList.length; i++) {
        const img = note.imageList[i];
        if (!img.url) continue;

        const ext = img.url.includes('.png') ? '.png' : '.jpg';
        const filename = `${i + 1}${ext}`;
        const destPath = path.join(downloadDir, filename);

        try {
          const result = await downloadFile(img.url, destPath, apiRequest, { resourceType: 'image' });

          // Record in database
          db.downloads.record({
            noteId: params.noteId,
            fileType: 'image',
            filePath: destPath,
            originalUrl: img.url,
            fileSize: result.size,
          });

          downloaded.push({
            filename,
            size: result.size,
            url: img.url,
          });
        } catch (error) {
          errors.push({
            index: i + 1,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: downloaded.length > 0,
                noteId: params.noteId,
                downloadDir,
                downloaded: downloaded.length,
                total: note.imageList.length,
                files: downloaded,
                errors: errors.length > 0 ? errors : undefined,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case 'xhs_download_video': {
      const params = z
        .object({
          noteId: z.string(),
          xsecToken: z.string(),
          account: z.string().optional(),
        })
        .parse(args);

      let apiRequest: APIRequestContext | null = null;
      const multiParams: MultiAccountParams = { account: params.account };

      // 先取笔记详情（触发浏览器 context 初始化），再读取 request（蓝军 #9 冷启动修复）
      const results = await executeWithMultipleAccounts(pool, db, multiParams, 'get_note_for_download', async (ctx) => {
        // R4 P1 1019912496：来源校验必须在发请求前完成（fail-closed），
        // 否则未知/跨账号 token 已随 getNote 发出，校验 throw 无法阻止泄露。
        const chk = getCooccurrenceGuard().checkXsecSource(params.xsecToken, ctx.accountId);
        if (!chk.allow) throw new Error(`xsec token 校验失败（${chk.reason}）：消费路径不得补写来源`);
        const note = await ctx.client.getNote(params.noteId, params.xsecToken);
        apiRequest = ctx.client.request;
        return note;
      }, { capability: 'read' });

      const r = results[0];
      if (!r.success || !r.result) {
        return {
          content: [{ type: 'text', text: `Failed to get note: ${r.error || 'Note not found'}` }],
          isError: true,
        };
      }

      // 蓝军 #6：xsecToken 来源绑定已在上面的提取回调（ctx.accountId）内完成（fail-closed）

      // 蓝军 #9 冷启动出口保护：指定账号但浏览器 context 仍未初始化时，禁止回退直连（fail-closed）
      if (params.account && !apiRequest) {
        return {
          content: [
            {
              type: 'text',
              text: `Account egress unavailable: browser context not initialized for account "${params.account}". Refusing direct download to protect egress consistency.`,
            },
          ],
          isError: true,
        };
      }

      const note = r.result;
      if (!note.video || !note.video.url) {
        return {
          content: [{ type: 'text', text: 'No video found in this note' }],
          isError: true,
        };
      }

      // Download video
      const downloadDir = getVideoDownloadPath(params.noteId);
      await fs.ensureDir(downloadDir);

      const filename = `video.mp4`;
      const destPath = path.join(downloadDir, filename);

      try {
        const result = await downloadFile(note.video.url, destPath, apiRequest, { resourceType: 'video' });

        // Record in database
        db.downloads.record({
          noteId: params.noteId,
          fileType: 'video',
          filePath: destPath,
          originalUrl: note.video.url,
          fileSize: result.size,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  noteId: params.noteId,
                  filePath: destPath,
                  size: result.size,
                  duration: note.video.duration,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  noteId: params.noteId,
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown download tool: ${name}`);
  }
}
