/**
 * @fileoverview C4：发布配图 resolveImagePaths 对齐账号 downloadFile 出口。
 * @module xhs/utils/resolve-image-paths.test
 */
import '../../core/logger.js';
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'bun:test';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { resolveImagePaths, isHttpUrl } from './index.js';
import { config, paths } from '../../core/config.js';

/** 最小 JPEG（魔数 FF D8 FF） */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function makeApiRequest(body: Buffer = JPEG_BYTES) {
  const calls: { url: string; opts: any }[] = [];
  const apiRequest: any = {
    get: async (url: string, opts: any) => {
      calls.push({ url, opts });
      return { ok: () => true, status: () => 200, body: async () => body };
    },
  };
  return { apiRequest, calls };
}

describe('C4 resolveImagePaths', () => {
  const dataDir = path.join(os.tmpdir(), `xhs-c4-${Date.now()}`);
  const prevDataDir = config.data.dir;
  const tmpFiles: string[] = [];

  beforeAll(() => {
    config.data.dir = dataDir;
  });

  afterEach(async () => {
    for (const f of tmpFiles) {
      await fs.remove(f).catch(() => {});
    }
    tmpFiles.length = 0;
  });

  afterAll(async () => {
    config.data.dir = prevDataDir;
    await fs.remove(dataDir).catch(() => {});
  });

  it('本地路径不要求 apiRequest', async () => {
    const local = path.join(os.tmpdir(), `c4-local-${Date.now()}.jpg`);
    await fs.writeFile(local, JPEG_BYTES);
    tmpFiles.push(local);
    const out = await resolveImagePaths([local], null);
    expect(out).toEqual([local]);
  });

  it('HTTP URL 无 apiRequest → fail-closed', async () => {
    expect(isHttpUrl('https://sns-img.xhscdn.com/a.jpg')).toBe(true);
    await expect(resolveImagePaths(['https://sns-img.xhscdn.com/a.jpg'], null)).rejects.toThrow(
      /APIRequestContext/,
    );
  });

  it('HTTP URL 经 apiRequest，带头 Referer/Sec-Fetch', async () => {
    const { apiRequest, calls } = makeApiRequest();
    const out = await resolveImagePaths(['https://sns-img.xhscdn.com/foo.jpg'], apiRequest);
    expect(calls.length).toBe(1);
    expect(calls[0].opts.headers['Referer']).toBe('https://www.xiaohongshu.com/');
    expect(calls[0].opts.headers['Sec-Fetch-Site']).toBe('cross-site');
    expect(calls[0].opts.headers['Sec-Fetch-Dest']).toBe('image');
    expect(out.length).toBe(1);
    expect(out[0].startsWith(paths.tempImages)).toBe(true);
    expect(out[0].endsWith('.jpg') || out[0].endsWith('.jpeg')).toBe(true);
    tmpFiles.push(out[0]);
  });
});
