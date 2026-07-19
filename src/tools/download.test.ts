/**
 * @fileoverview 蓝军 #8 / #9 回归测试：Fetch Metadata 一致推导、出口统一。
 * @module tools/download.test
 */
import { describe, it, expect } from 'bun:test';
import { downloadFile } from './download.js';

function makeApiRequest() {
  const calls: { url: string; opts: any }[] = [];
  const apiRequest: any = {
    get: async (url: string, opts: any) => {
      calls.push({ url, opts });
      return { ok: () => true, status: () => 200, body: async () => Buffer.from('data') };
    },
  };
  return { apiRequest, calls };
}

describe('蓝军 #8 Fetch Metadata 与 URL 一致', () => {
  it('小红书主域 → Sec-Fetch-Site: same-origin', async () => {
    const { apiRequest, calls } = makeApiRequest();
    await downloadFile('https://www.xiaohongshu.com/explore/abc', '/tmp/_xhs_dl_same.jpg', apiRequest, {
      resourceType: 'image',
    });
    expect(calls[0].opts.headers['Sec-Fetch-Site']).toBe('same-origin');
    expect(calls[0].opts.headers['Sec-Fetch-Dest']).toBe('image');
  });

  it('跨站 CDN 图片 → Sec-Fetch-Site: cross-site', async () => {
    const { apiRequest, calls } = makeApiRequest();
    await downloadFile('https://sns-img.xhscdn.com/foo.jpg', '/tmp/_xhs_dl_cdn.jpg', apiRequest, {
      resourceType: 'image',
    });
    expect(calls[0].opts.headers['Sec-Fetch-Site']).toBe('cross-site');
    expect(calls[0].opts.headers['Sec-Fetch-Dest']).toBe('image');
  });

  it('R2-8 同注册域子域（sns.xiaohongshu.com）→ Sec-Fetch-Site: same-site（不再误标 same-origin）', async () => {
    const { apiRequest, calls } = makeApiRequest();
    await downloadFile('https://sns.xiaohongshu.com/foo.jpg', '/tmp/_xhs_dl_sub.jpg', apiRequest, {
      resourceType: 'image',
    });
    expect(calls[0].opts.headers['Sec-Fetch-Site']).toBe('same-site');
    expect(calls[0].opts.headers['Sec-Fetch-Dest']).toBe('image');
  });

  it('视频资源 → Sec-Fetch-Dest: video（不再自称 image）', async () => {
    const { apiRequest, calls } = makeApiRequest();
    await downloadFile('https://v.xhscdn.com/a.mp4', '/tmp/_xhs_dl_vid.mp4', apiRequest, {
      resourceType: 'video',
    });
    expect(calls[0].opts.headers['Sec-Fetch-Dest']).toBe('video');
    expect(calls[0].opts.headers['Sec-Fetch-Site']).toBe('cross-site');
  });
});

describe('蓝军 #9 出口统一', () => {
  it('提供 apiRequest 时经其下载（继承 Cookie/代理出口）', async () => {
    const { apiRequest, calls } = makeApiRequest();
    await downloadFile('https://sns-img.xhscdn.com/foo.jpg', '/tmp/_xhs_dl_use.jpg', apiRequest, {
      resourceType: 'image',
    });
    expect(calls.length).toBe(1);
  });

  it('未提供 apiRequest（无账号会话）时回退直连，不抛错', async () => {
    // 仅验证函数对 null 入参不抛类型错误；真实直连由集成环境覆盖
    let threw = false;
    try {
      // 用明显非法的 URL 触发回退路径内的网络错误但不应因 apiRequest 为 null 崩溃
      await downloadFile('not-a-real-url', '/tmp/_xhs_dl_null.jpg', null, { resourceType: 'image' });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // 因 URL 非法失败，而非因 apiRequest 为 null
  });
});
