/**
 * @fileoverview B4 Explore 纯逻辑辅助：打开率冷却/衰减、视频接触率。
 * 抽离便于单测，不依赖 Page/DOM。
 * @module xhs/clients/services/explore-helpers
 */

/** 打开率冷却状态（会话内） */
export interface OpenRateCooldownState {
  /** 打开后累积的冷却惩罚 0~MAX_PENALTY，降低有效打开率 */
  cooldownPenalty: number;
  /** 连续未打开轮次，用于缓慢恢复冷却与温和兜底加成 */
  idleRounds: number;
}

/** 打开率冷却/衰减参数 */
export const OPEN_RATE_COOLDOWN = {
  /** 每次成功打开增加的惩罚 */
  PENALTY_PER_OPEN: 0.22,
  /** 惩罚上限 */
  MAX_PENALTY: 0.65,
  /** 每轮未打开时冷却衰减量（缓慢恢复） */
  RECOVERY_PER_IDLE: 0.04,
  /**
   * 连续未打开的温和兜底加成（替代旧 `skippedRounds * 0.1` 线性爬升，
   * 避免长时间只滑不点或短时间 burst 打开）。
   */
  SKIPPED_BOOST_PER_ROUND: 0.04,
  MAX_SKIPPED_BOOST: 0.25,
  MIN_RATE: 0.05,
  MAX_RATE: 0.85,
} as const;

export function createOpenRateCooldownState(): OpenRateCooldownState {
  return { cooldownPenalty: 0, idleRounds: 0 };
}

/**
 * 计算当前轮有效打开率：基线 × (1 - 冷却惩罚) + 空闲兜底加成。
 * 打开后惩罚升高（暂时少点）；多轮未打开则惩罚衰减并略增兜底率。
 */
export function computeEffectiveOpenRate(
  baseOpenRate: number,
  state: OpenRateCooldownState,
): number {
  const skippedBoost = Math.min(
    state.idleRounds * OPEN_RATE_COOLDOWN.SKIPPED_BOOST_PER_ROUND,
    OPEN_RATE_COOLDOWN.MAX_SKIPPED_BOOST,
  );
  const cooled = baseOpenRate * (1 - state.cooldownPenalty) + skippedBoost;
  return Math.min(
    Math.max(cooled, OPEN_RATE_COOLDOWN.MIN_RATE),
    OPEN_RATE_COOLDOWN.MAX_RATE,
  );
}

/** 一轮结束后更新冷却状态 */
export function updateOpenRateStateAfterRound(
  state: OpenRateCooldownState,
  opened: boolean,
): OpenRateCooldownState {
  if (opened) {
    return {
      cooldownPenalty: Math.min(
        state.cooldownPenalty + OPEN_RATE_COOLDOWN.PENALTY_PER_OPEN,
        OPEN_RATE_COOLDOWN.MAX_PENALTY,
      ),
      idleRounds: 0,
    };
  }
  return {
    cooldownPenalty: Math.max(
      state.cooldownPenalty - OPEN_RATE_COOLDOWN.RECOVERY_PER_IDLE,
      0,
    ),
    idleRounds: state.idleRounds + 1,
  };
}

/** 统计 feed 中视频占比（0~1） */
export function computeFeedVideoRatio(feeds: Array<{ noteCard: { type: string } }>): number {
  if (feeds.length === 0) return 0;
  const videoCount = feeds.filter((f) => f.noteCard.type === 'video').length;
  return videoCount / feeds.length;
}

/**
 * 是否在本轮尝试视频接触：接触率与 feed 视频占比成比例。
 * 略上浮（×1.15）以弥补历史硬跳过，上限 0.55；无视频时恒 false。
 */
export function shouldContactVideoFeed(
  videoRatio: number,
  roll: number,
): boolean {
  if (videoRatio <= 0) return false;
  const contactRate = Math.min(Math.max(videoRatio * 1.15, 0.08), 0.55);
  return roll < contactRate;
}
