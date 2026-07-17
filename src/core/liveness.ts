/**
 * @fileoverview C3.2 息屏/无人值守自保（蓝军报告 07）。
 *
 * 写操作需设备在场：检测到显示器 asleep 或长时间无人工确认时，只允许停止/shadow，
 * 不自动互动或发布。本模块是纯稳健性保护（非检测规避）：
 *  - 显示器 asleep 检测仅在 darwin 通过 `ioreg` 轮询，非 darwin 恒判为 awake（放行），避免误杀；
 *  - 空闲超时（idleTimeoutMs）默认关闭，避免误杀离线批处理，运维按需开启；
 *  - 任何解析失败/异常均按"放行"处理（fail-open），绝不因本模块阻断正常业务。
 *
 * 写操作门禁接入点：`core/multi-account.ts` 的 `executeWithAccount`（所有多账号写操作的唯一汇聚点）。
 * @module core/liveness
 */

import { execFile } from 'node:child_process';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('liveness');

/** darwin 上判定 asleep 的 CurrentPowerState 阈值：<= 该值视为显示器已睡眠 */
const ASLEEP_STATE_MAX = 1;

/**
 * 由 ioreg 的 CurrentPowerState 判定显示器是否 asleep。
 * null（无法判定，如解析失败/非 darwin）按 awake 处理（fail-open），绝不因不确定而阻断业务。
 */
export function isAsleepState(state: number | null): boolean {
  if (state === null) return false;
  return state <= ASLEEP_STATE_MAX;
}

interface LivenessState {
  /** 是否允许写操作 */
  allowed: boolean;
  /** 不允许时的原因（用于审计/日志） */
  reason?: 'display_asleep' | 'idle_timeout';
}

class LivenessMonitor {
  private lastActivityMs = Date.now();
  private displayAsleep = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private lastWarnAt = 0;

  /** 记录一次人工确认/工具调用，重置空闲计时 */
  recordActivity(): void {
    this.lastActivityMs = Date.now();
  }

  /** 懒启动轮询（仅 darwin + 已启用） */
  async ensureStarted(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const { enabled, pollIntervalMs } = config.antiDetect.liveness;
    if (!enabled || process.platform !== 'darwin') {
      if (process.platform !== 'darwin') {
        log.debug('非 darwin 平台，跳过显示器 asleep 轮询（恒放行）');
      }
      return;
    }
    // R3-6：启动即采样一次真实显示器状态，避免首轮默认 displayAsleep=false 误放行已息屏的设备
    await this.pollDisplayState();
    if (pollIntervalMs > 0) {
      this.timer = setInterval(() => void this.pollDisplayState(), pollIntervalMs);
      // 不阻止进程退出
      if (typeof this.timer.unref === 'function') this.timer.unref();
      log.info('息屏自保轮询已启动', { pollIntervalMs });
    }
  }

  /** R3-6：确保已完成首次真实采样（供 explore 启动 / 服务启动 await，避免默认 awake 误放行） */
  async awaitFirstSample(): Promise<void> {
    await this.ensureStarted();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  /** 查询当前是否允许写操作 */
  isWriteAllowed(): LivenessState {
    this.ensureStarted();
    const { enabled, idleTimeoutMs } = config.antiDetect.liveness;
    if (!enabled) return { allowed: true };

    if (this.displayAsleep) {
      this.throttledWarn('显示器处于 asleep，停写（值守保护）');
      return { allowed: false, reason: 'display_asleep' };
    }

    if (idleTimeoutMs > 0) {
      const idleFor = Date.now() - this.lastActivityMs;
      if (idleFor > idleTimeoutMs) {
        this.throttledWarn('超过无人确认阈值，停写（值守保护）', { idleFor });
        return { allowed: false, reason: 'idle_timeout' };
      }
    }

    return { allowed: true };
  }

  /** 供测试/运维观测 */
  getState(): { displayAsleep: boolean; idleForMs: number; enabled: boolean } {
    return {
      displayAsleep: this.displayAsleep,
      idleForMs: Date.now() - this.lastActivityMs,
      enabled: config.antiDetect.liveness.enabled,
    };
  }

  private throttledWarn(msg: string, extra?: Record<string, unknown>): void {
    const now = Date.now();
    // 每 5 分钟最多一条告警，避免刷屏
    if (now - this.lastWarnAt > 300_000) {
      this.lastWarnAt = now;
      log.warn(msg, extra);
    }
  }

  /** 轮询 macOS 显示器电源状态（best-effort，失败按 awake 处理） */
  private async pollDisplayState(): Promise<void> {
    try {
        const state = await queryDisplayPowerState();
        // state === null：无法判定 → 保持上次值（默认 awake），不翻转
        if (state !== null) {
          const asleep = isAsleepState(state);
          if (asleep !== this.displayAsleep) {
          this.displayAsleep = asleep;
          log.info('显示器状态变化', { currentPowerState: state, asleep });
        }
      }
    } catch (err) {
      // 任何异常按 awake 处理，fail-open
      log.debug('显示器状态轮询失败，按 awake 处理', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * 通过 ioreg 读取 IODisplayWrangler 的 CurrentPowerState。
 * 返回数值（4=on, 越低越接近睡眠），无法判定返回 null。
 */
export function queryDisplayPowerState(): Promise<number | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 3000);
    execFile(
      'ioreg',
      ['-r', '-d', '0', '-n', 'IODisplayWrangler'],
      { encoding: 'utf8' },
      (err, stdout) => {
        clearTimeout(timeout);
        if (err) {
          resolve(null);
          return;
        }
        const match = stdout.match(/"CurrentPowerState"\s*=\s*(\d+)/);
        if (!match) {
          resolve(null);
          return;
        }
        resolve(parseInt(match[1], 10));
      },
    );
  });
}

/** 进程级单例 */
let instance: LivenessMonitor | null = null;

export function getLiveness(): LivenessMonitor {
  if (!instance) instance = new LivenessMonitor();
  return instance;
}

export function recordHumanActivity(): void {
  getLiveness().recordActivity();
}

export function isWriteAllowed(): LivenessState {
  return getLiveness().isWriteAllowed();
}

export function startLivenessMonitor(): Promise<void> {
  return getLiveness().ensureStarted();
}

/**
 * R3-1：为 stdio 模式（无 HTTP 路由）提供本机人工在场确认通道。
 * 终端前的人工按下 `kill -USR1 <pid>` 即记录一次在场，重置空闲超时——
 * 独立于 MCP 调用，自动化客户端无法伪造。
 */
export function installPresenceSignal(): void {
  process.on('SIGUSR1', () => {
    getLiveness().recordActivity();
    log.info('收到 SIGUSR1 信号，记录一次人工在场（空闲超时重置）');
  });
}

export function stopLivenessMonitor(): void {
  getLiveness().stop();
}
