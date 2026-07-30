import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Browser, BrowserContext } from 'patchright';
import { BrowserContextManager } from './context.js';

class FakeBrowser extends EventEmitter {
  connected = true;

  isConnected(): boolean {
    return this.connected;
  }

  async close(): Promise<void> {
    this.connected = false;
    this.emit('disconnected');
  }
}

class FakeContext extends EventEmitter {
  closeUnexpectedly(): void {
    this.emit('close');
  }
}

function browser(value: FakeBrowser): Browser {
  return value as unknown as Browser;
}

function context(value: FakeContext): BrowserContext {
  return value as unknown as BrowserContext;
}

describe('BrowserContextManager 关闭恢复', () => {
  it('context 被人工关闭后，下一次请求复用同一个 profile 重新创建', async () => {
    const sessions = [
      { browser: new FakeBrowser(), context: new FakeContext() },
      { browser: new FakeBrowser(), context: new FakeContext() },
    ];
    const profileDirs: string[] = [];
    const manager = new BrowserContextManager(
      { profileId: 'profile-one' },
      async (profileDir) => {
        profileDirs.push(profileDir);
        const session = sessions[profileDirs.length - 1];
        return { browser: browser(session.browser), context: context(session.context) };
      },
    );

    expect(await manager.ensureContext()).toBe(context(sessions[0].context));
    sessions[0].context.closeUnexpectedly();
    expect(manager.context).toBeNull();
    expect(manager.browser).toBeNull();

    expect(await manager.ensureContext()).toBe(context(sessions[1].context));
    expect(profileDirs).toHaveLength(2);
    expect(profileDirs[1]).toBe(profileDirs[0]);
  });

  it('browser 已断连但尚未发出事件时，也会在下一次请求前重建', async () => {
    const sessions = [
      { browser: new FakeBrowser(), context: new FakeContext() },
      { browser: new FakeBrowser(), context: new FakeContext() },
    ];
    let launches = 0;
    const manager = new BrowserContextManager(
      { profileId: 'profile-one' },
      async () => {
        const session = sessions[launches++];
        return { browser: browser(session.browser), context: context(session.context) };
      },
    );

    await manager.ensureContext();
    sessions[0].browser.connected = false;

    expect(await manager.ensureContext()).toBe(context(sessions[1].context));
    expect(launches).toBe(2);
  });
});
