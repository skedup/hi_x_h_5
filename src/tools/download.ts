/**
 * @fileoverview MCP tool definitions and handlers for downloading media.
 * Provides tools for downloading images and videos from notes.
 * @module tools/download
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import fs from 'fs-extra';
import path from 'path';
import type { APIRequestContext } from 'patchright';
import { AccountPool } from '../core/account-pool.js';
import { XhsDatabase } from '../db/index.js';
import { getImageDownloadPath, getVideoDownloadPath } from '../core/paths.js';
import { executeWithMultipleAccounts, MultiAccountParams } from '../core/multi-account.js';
import { getCooccurrenceGuard } from '../core/antidetect.js';
import { downloadFile } from '../core/account-download.js';

/** 供测试与外部复用：账号会话下载出口 */
export { downloadFile } from '../core/account-download.js';

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
