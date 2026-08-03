/**
 * @fileoverview Interaction service for BrowserClient.
 * Contains methods for liking, favoriting, and commenting.
 * @module xhs/clients/services/interact
 */

import type { Page } from 'patchright';
import { InteractionResult, CommentResult, InteractSessionMeta } from '../../types.js';
import {
  navigateWithRetry,
  typeLikeHuman,
  jitteredSleep,
  rateLimitedSleep,
  heavyTailDelay,
  clickWithTrajectory,
  getLastTrajectoryMeta,
  computeTypingPlan,
  type TypeLikeHumanOptions,
} from '../../utils/index.js';
import {
  InteractSessionOpts,
  runInteractReadingPhase,
  runInteractPostStay,
  finalizeInteractSessionMeta,
} from '../../utils/interact-session.js';
import { config } from '../../../core/config.js';
import { BrowserContextManager } from '../context.js';
import { REQUEST_INTERVAL, INTERACTION_SELECTORS, COMMENT_SELECTORS } from '../constants.js';
import { createLogger } from '../../../core/logger.js';

function buildNoteUrl(noteId: string, xsecToken: string): string {
  let url = `https://www.xiaohongshu.com/explore/${noteId}`;
  if (xsecToken) {
    url += `?xsec_token=${encodeURIComponent(xsecToken)}`;
  }
  return url;
}

/** B6：评论/回复输入启用 revise，与 publish 正文策略对齐 */
function commentTypingOptions(content: string): TypeLikeHumanOptions {
  return {
    reviseGapMin: 4,
    reviseGapMax: 12,
    reviseMax: 1,
    reviseChance: 0.8,
    ...computeTypingPlan(content, {
      minDelay: 45,
      maxDelay: 170,
      reviseGapMin: 4,
      reviseGapMax: 12,
      reviseMax: 1,
      reviseChance: 0.8,
      defaultMaxDurationMs: 60000,
    }),
  };
}

/**
 * Interact service - handles note interactions (like, favorite, comment)
 */
export class InteractService {
  private logger = createLogger('interact');
  /** keepPage=true 时暂存的页面；须由 releaseKeptPages() 关闭，避免 orphan tab */
  private keptPages = new Set<Page>();

  constructor(private ctx: BrowserContextManager) {}

  /** 当前保留未关的 Interact 页数量 */
  getKeptPageCount(): number {
    return this.keptPages.size;
  }

  /**
   * 关闭所有 keepPage 保留的页面。批处理结束后应调用。
   * @returns 实际关闭的页数
   */
  async releaseKeptPages(): Promise<number> {
    let closed = 0;
    for (const page of [...this.keptPages]) {
      this.keptPages.delete(page);
      try {
        if (!page.isClosed()) {
          await page.close();
          closed += 1;
        }
      } catch (err) {
        this.logger.warn('B3 releaseKeptPages: close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return closed;
  }

  private async retainOrClosePage(page: Page, keepPage: boolean): Promise<void> {
    if (keepPage) {
      this.keptPages.add(page);
      this.logger.info('B3 keepPage: page retained', {
        keptCount: this.keptPages.size,
        hint: 'call releaseKeptPages() when batch finishes',
      });
      return;
    }
    await page.close().catch(() => {});
  }

  /** 阅读阶段之后统一跑 post-stay 并落 meta（含失败早退路径） */
  private async completeSession(parts: {
    preDwellMs: number;
    readScrollCount: number;
    trajectorySteps: number | null;
    keepPage: boolean;
    /** B7：已处于目标状态、无需点击 */
    alreadyDone?: boolean;
  }): Promise<InteractSessionMeta> {
    const sessionEnabled = !!config.antiDetect.interactSession?.enabled;
    const shortSession = !!parts.alreadyDone && !!config.antiDetect.alreadyDoneShort?.enabled;
    const post = await runInteractPostStay({ shortSession });
    return finalizeInteractSessionMeta({
      enabled: sessionEnabled,
      preDwellMs: parts.preDwellMs,
      readScrollCount: parts.readScrollCount,
      postStayMs: post.postStayMs,
      trajectorySteps: parts.trajectorySteps,
      keepPage: parts.keepPage,
      skippedAlreadyDone: post.skippedAlreadyDone,
    });
  }

  /**
   * Like or unlike a note.
   * B3 模板：goto → 重尾 dwell → ≥1 阅读 scroll → 轨迹 click → 动作后停留 → close（可选 keepPage）。
   */
  async likeFeed(
    noteId: string,
    xsecToken: string,
    unlike: boolean = false,
    sessionOpts: InteractSessionOpts = {},
  ): Promise<InteractionResult> {
    await this.ctx.ensureContext();
    const page = await this.ctx.newPage();
    const keepPage = !!sessionOpts.keepPage;
    let trajectorySteps: number | null = null;
    let preDwellMs = 0;
    let readScrollCount = 0;
    let readingStarted = false;
    const sessionEnabled = !!config.antiDetect.interactSession?.enabled;

    try {
      const accessError = await navigateWithRetry(page, buildNoteUrl(noteId, xsecToken));
      if (accessError) {
        return {
          success: false,
          action: unlike ? 'unlike' : 'like',
          noteId,
          error: accessError,
        };
      }
      await rateLimitedSleep(REQUEST_INTERVAL);

      const reading = await runInteractReadingPhase(page);
      readingStarted = true;
      preDwellMs = reading.preDwellMs;
      readScrollCount = reading.readScrollCount;

      const isLiked = await page.evaluate(
        () => {
          const state = (window as any).__INITIAL_STATE__;
          const noteDetailMap = state?.note?.noteDetailMap;
          if (noteDetailMap) {
            const firstKey = Object.keys(noteDetailMap)[0];
            return noteDetailMap[firstKey]?.note?.interactInfo?.liked || false;
          }
          return false;
        },
        null,
        false,
      );

      const shouldClick = (unlike && isLiked) || (!unlike && !isLiked);

      if (shouldClick) {
        const likeBtn = await page.$(INTERACTION_SELECTORS.likeButton);
        if (!likeBtn) {
          const session = await this.completeSession({
            preDwellMs,
            readScrollCount,
            trajectorySteps,
            keepPage,
          });
          return {
            success: false,
            action: unlike ? 'unlike' : 'like',
            noteId,
            error: 'Like button not found',
            session,
          };
        }
        await clickWithTrajectory(page, likeBtn);
        trajectorySteps = getLastTrajectoryMeta()?.steps ?? null;
        if (!sessionEnabled) {
          await heavyTailDelay(500, { minMs: 300, maxMs: 700 });
        }
      } else {
        this.logger.info('skipped_already_done', {
          action: unlike ? 'unlike' : 'like',
          noteId,
          shortSession: !!config.antiDetect.alreadyDoneShort?.enabled,
        });
      }

      const session = await this.completeSession({
        preDwellMs,
        readScrollCount,
        trajectorySteps,
        keepPage,
        alreadyDone: !shouldClick,
      });

      if (shouldClick) {
        this.logger.info('interact_success', {
          action: unlike ? 'unlike' : 'like',
          noteId,
          trajectorySteps,
          postStayMs: session.postStayMs,
        });
      }

      return {
        success: true,
        action: unlike ? 'unlike' : 'like',
        noteId,
        alreadyDone: !shouldClick,
        session,
      };
    } catch (error) {
      let session: InteractSessionMeta | undefined;
      if (readingStarted) {
        session = await this.completeSession({
          preDwellMs,
          readScrollCount,
          trajectorySteps,
          keepPage,
        }).catch(() => undefined);
      }
      return {
        success: false,
        action: unlike ? 'unlike' : 'like',
        noteId,
        error: error instanceof Error ? error.message : String(error),
        session,
      };
    } finally {
      await this.retainOrClosePage(page, keepPage);
    }
  }

  /**
   * Favorite (collect) or unfavorite a note.
   */
  async favoriteFeed(
    noteId: string,
    xsecToken: string,
    unfavorite: boolean = false,
    sessionOpts: InteractSessionOpts = {},
  ): Promise<InteractionResult> {
    await this.ctx.ensureContext();
    const page = await this.ctx.newPage();
    const keepPage = !!sessionOpts.keepPage;
    let trajectorySteps: number | null = null;
    let preDwellMs = 0;
    let readScrollCount = 0;
    let readingStarted = false;
    const sessionEnabled = !!config.antiDetect.interactSession?.enabled;

    try {
      const accessError = await navigateWithRetry(page, buildNoteUrl(noteId, xsecToken));
      if (accessError) {
        return {
          success: false,
          action: unfavorite ? 'unfavorite' : 'favorite',
          noteId,
          error: accessError,
        };
      }
      await rateLimitedSleep(REQUEST_INTERVAL);

      const reading = await runInteractReadingPhase(page);
      readingStarted = true;
      preDwellMs = reading.preDwellMs;
      readScrollCount = reading.readScrollCount;

      const isCollected = await page.evaluate(
        () => {
          const state = (window as any).__INITIAL_STATE__;
          const noteDetailMap = state?.note?.noteDetailMap;
          if (noteDetailMap) {
            const firstKey = Object.keys(noteDetailMap)[0];
            return noteDetailMap[firstKey]?.note?.interactInfo?.collected || false;
          }
          return false;
        },
        null,
        false,
      );

      const shouldClick = (unfavorite && isCollected) || (!unfavorite && !isCollected);

      if (shouldClick) {
        const collectBtn = await page.$(INTERACTION_SELECTORS.collectButton);
        if (!collectBtn) {
          const session = await this.completeSession({
            preDwellMs,
            readScrollCount,
            trajectorySteps,
            keepPage,
          });
          return {
            success: false,
            action: unfavorite ? 'unfavorite' : 'favorite',
            noteId,
            error: 'Collect button not found',
            session,
          };
        }
        await clickWithTrajectory(page, collectBtn);
        trajectorySteps = getLastTrajectoryMeta()?.steps ?? null;
        if (!sessionEnabled) {
          await heavyTailDelay(500, { minMs: 300, maxMs: 700 });
        }
      } else {
        this.logger.info('skipped_already_done', {
          action: unfavorite ? 'unfavorite' : 'favorite',
          noteId,
          shortSession: !!config.antiDetect.alreadyDoneShort?.enabled,
        });
      }

      const session = await this.completeSession({
        preDwellMs,
        readScrollCount,
        trajectorySteps,
        keepPage,
        alreadyDone: !shouldClick,
      });

      if (shouldClick) {
        this.logger.info('interact_success', {
          action: unfavorite ? 'unfavorite' : 'favorite',
          noteId,
          trajectorySteps,
          postStayMs: session.postStayMs,
        });
      }

      return {
        success: true,
        action: unfavorite ? 'unfavorite' : 'favorite',
        noteId,
        alreadyDone: !shouldClick,
        session,
      };
    } catch (error) {
      let session: InteractSessionMeta | undefined;
      if (readingStarted) {
        session = await this.completeSession({
          preDwellMs,
          readScrollCount,
          trajectorySteps,
          keepPage,
        }).catch(() => undefined);
      }
      return {
        success: false,
        action: unfavorite ? 'unfavorite' : 'favorite',
        noteId,
        error: error instanceof Error ? error.message : String(error),
        session,
      };
    } finally {
      await this.retainOrClosePage(page, keepPage);
    }
  }

  /**
   * Post a comment on a note.
   */
  async postComment(
    noteId: string,
    xsecToken: string,
    content: string,
    sessionOpts: InteractSessionOpts = {},
  ): Promise<CommentResult> {
    await this.ctx.ensureContext();
    const page = await this.ctx.newPage();
    const keepPage = !!sessionOpts.keepPage;
    let trajectorySteps: number | null = null;
    let preDwellMs = 0;
    let readScrollCount = 0;
    let readingStarted = false;

    try {
      const accessError = await navigateWithRetry(page, buildNoteUrl(noteId, xsecToken));
      if (accessError) {
        return { success: false, error: accessError };
      }
      await rateLimitedSleep(REQUEST_INTERVAL);

      const reading = await runInteractReadingPhase(page);
      readingStarted = true;
      preDwellMs = reading.preDwellMs;
      readScrollCount = reading.readScrollCount;

      const inputTrigger = await page.$(COMMENT_SELECTORS.commentInputTrigger);
      if (inputTrigger) {
        await clickWithTrajectory(page, inputTrigger);
        await heavyTailDelay(500, { minMs: 300, maxMs: 700 });
      }

      const commentInput = await page.$(COMMENT_SELECTORS.commentInput);
      if (!commentInput) {
        const session = await this.completeSession({
          preDwellMs,
          readScrollCount,
          trajectorySteps,
          keepPage,
        });
        return { success: false, error: 'Comment input not found', session };
      }

      await clickWithTrajectory(page, commentInput);
      await typeLikeHuman(page, content, commentTypingOptions(content));
      await heavyTailDelay(300, { minMs: 180, maxMs: 420 });

      const submitBtn = await page.$(COMMENT_SELECTORS.submitButton);
      if (!submitBtn) {
        const session = await this.completeSession({
          preDwellMs,
          readScrollCount,
          trajectorySteps,
          keepPage,
        });
        return { success: false, error: 'Submit button not found', session };
      }

      await clickWithTrajectory(page, submitBtn);
      trajectorySteps = getLastTrajectoryMeta()?.steps ?? null;
      await jitteredSleep(1000);

      const submitted = await page
        .waitForFunction(
          (selector) => {
            const input = document.querySelector(selector);
            if (!input) return false;
            const value = input instanceof HTMLTextAreaElement ? input.value : input.textContent || '';
            return value.trim().length === 0;
          },
          COMMENT_SELECTORS.commentInput,
          { timeout: 3000 },
        )
        .then(() => true)
        .catch(() => false);

      const session = await this.completeSession({
        preDwellMs,
        readScrollCount,
        trajectorySteps,
        keepPage,
      });

      return submitted
        ? { success: true, session }
        : { success: false, error: 'Comment outcome unconfirmed', sideEffectPossible: true, session };
    } catch (error) {
      let session: InteractSessionMeta | undefined;
      if (readingStarted) {
        session = await this.completeSession({
          preDwellMs,
          readScrollCount,
          trajectorySteps,
          keepPage,
        }).catch(() => undefined);
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        sideEffectPossible: true,
        session,
      };
    } finally {
      await this.retainOrClosePage(page, keepPage);
    }
  }

  /**
   * Reply to a comment on a note.
   */
  async replyComment(
    noteId: string,
    xsecToken: string,
    commentId: string,
    content: string,
    sessionOpts: InteractSessionOpts = {},
  ): Promise<CommentResult> {
    await this.ctx.ensureContext();
    const page = await this.ctx.newPage();
    const keepPage = !!sessionOpts.keepPage;
    let trajectorySteps: number | null = null;
    let preDwellMs = 0;
    let readScrollCount = 0;
    let readingStarted = false;

    try {
      const accessError = await navigateWithRetry(page, buildNoteUrl(noteId, xsecToken));
      if (accessError) {
        return { success: false, error: accessError };
      }
      await rateLimitedSleep(REQUEST_INTERVAL);

      const reading = await runInteractReadingPhase(page);
      readingStarted = true;
      preDwellMs = reading.preDwellMs;
      readScrollCount = reading.readScrollCount;

      await heavyTailDelay(2000, { minMs: 1200, maxMs: 2800 });

      const commentEl = await this.findCommentElement(page, commentId);
      if (!commentEl) {
        const session = await this.completeSession({
          preDwellMs,
          readScrollCount,
          trajectorySteps,
          keepPage,
        });
        return { success: false, error: `Comment not found: ${commentId}`, session };
      }

      await commentEl.scrollIntoViewIfNeeded();
      await heavyTailDelay(1000, { minMs: 600, maxMs: 1400 });

      const replyBtn = await commentEl.$('.right .interactions .reply');
      if (!replyBtn) {
        const session = await this.completeSession({
          preDwellMs,
          readScrollCount,
          trajectorySteps,
          keepPage,
        });
        return { success: false, error: 'Reply button not found', session };
      }

      await clickWithTrajectory(page, replyBtn);
      await heavyTailDelay(1000, { minMs: 600, maxMs: 1400 });

      const commentInput = await page.$('div.input-box div.content-edit p.content-input');
      if (!commentInput) {
        const session = await this.completeSession({
          preDwellMs,
          readScrollCount,
          trajectorySteps,
          keepPage,
        });
        return { success: false, error: 'Reply input not found', session };
      }

      await clickWithTrajectory(page, commentInput);
      await typeLikeHuman(page, content, commentTypingOptions(content));
      await heavyTailDelay(500, { minMs: 300, maxMs: 700 });

      const submitBtn = await page.$('div.bottom button.submit');
      if (!submitBtn) {
        const session = await this.completeSession({
          preDwellMs,
          readScrollCount,
          trajectorySteps,
          keepPage,
        });
        return { success: false, error: 'Submit button not found', session };
      }

      await clickWithTrajectory(page, submitBtn);
      trajectorySteps = getLastTrajectoryMeta()?.steps ?? null;
      await jitteredSleep(2000);

      const submitted = await page
        .waitForFunction(
          (selector) => {
            const input = document.querySelector(selector);
            if (!input) return false;
            return (input.textContent || '').trim().length === 0;
          },
          'div.input-box div.content-edit p.content-input',
          { timeout: 3000 },
        )
        .then(() => true)
        .catch(() => false);

      const session = await this.completeSession({
        preDwellMs,
        readScrollCount,
        trajectorySteps,
        keepPage,
      });

      return submitted
        ? { success: true, session }
        : { success: false, error: 'Reply outcome unconfirmed', sideEffectPossible: true, session };
    } catch (error) {
      let session: InteractSessionMeta | undefined;
      if (readingStarted) {
        session = await this.completeSession({
          preDwellMs,
          readScrollCount,
          trajectorySteps,
          keepPage,
        }).catch(() => undefined);
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        sideEffectPossible: true,
        session,
      };
    } finally {
      await this.retainOrClosePage(page, keepPage);
    }
  }

  /**
   * 查找评论元素，支持滚动加载
   */
  private async findCommentElement(page: any, commentId: string): Promise<any> {
    const maxAttempts = 50;
    const selector = `#comment-${commentId}`;

    this.logger.debug('查找评论元素', { commentId, selector });

    let el = await page.$(selector);
    if (el) {
      this.logger.debug('在当前页面找到评论');
      return el;
    }

    await page.evaluate(() => {
      const commentsArea = document.querySelector('.comments-container, .comment-list, .note-comments');
      if (commentsArea) {
        commentsArea.scrollIntoView({ behavior: 'smooth' });
      }
    });
    await heavyTailDelay(1000, { minMs: 600, maxMs: 1400 });

    el = await page.$(selector);
    if (el) {
      this.logger.debug('滚动到评论区后找到评论');
      return el;
    }

    const commentIds = await page
      .$$eval('[id^="comment-"]', (els: Element[]) => els.map((e) => e.id))
      .catch(() => [] as string[]);
    this.logger.debug('当前页面评论ID列表', { count: commentIds.length, ids: commentIds.slice(0, 10) });

    let lastCommentCount = 0;
    let stagnantChecks = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const hasEndContainer = await page.$('.end-container, .comments-end, .no-more-comments');
      if (hasEndContainer && attempt > 5) {
        this.logger.debug('到达评论底部', { attempt });
        break;
      }

      const currentCount = await page
        .$$eval('.comment-item, .parent-comment', (els: Element[]) => els.length)
        .catch(() => 0);

      if (currentCount !== lastCommentCount) {
        lastCommentCount = currentCount;
        stagnantChecks = 0;
      } else {
        stagnantChecks++;
      }

      if (stagnantChecks >= 10) {
        this.logger.debug('评论数停滞', { attempt, stagnantChecks });
        break;
      }

      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 0.8);
      });
      await heavyTailDelay(800, { minMs: 500, maxMs: 1400 });

      el = await page.$(selector);
      if (el) {
        this.logger.debug('滚动查找后找到评论', { attempt });
        return el;
      }
    }

    el = await page.$(selector);
    if (!el) {
      this.logger.warn('未找到评论', { commentId, selector });
    }
    return el;
  }

  /**
   * Like or unlike a comment.
   */
  async likeComment(
    noteId: string,
    xsecToken: string,
    commentId: string,
    unlike: boolean = false,
    sessionOpts: InteractSessionOpts = {},
  ): Promise<InteractionResult> {
    this.logger.info('开始点赞评论', { noteId, commentId, unlike });
    await this.ctx.ensureContext();
    const page = await this.ctx.newPage();
    const keepPage = !!sessionOpts.keepPage;
    let trajectorySteps: number | null = null;
    let preDwellMs = 0;
    let readScrollCount = 0;
    let readingStarted = false;
    const sessionEnabled = !!config.antiDetect.interactSession?.enabled;

    try {
      const accessError = await navigateWithRetry(page, buildNoteUrl(noteId, xsecToken));
      if (accessError) {
        this.logger.error('页面访问失败', { error: accessError });
        return {
          success: false,
          action: unlike ? 'unlike' : 'like',
          noteId,
          error: accessError,
        };
      }
      await rateLimitedSleep(REQUEST_INTERVAL);

      const reading = await runInteractReadingPhase(page);
      readingStarted = true;
      preDwellMs = reading.preDwellMs;
      readScrollCount = reading.readScrollCount;

      await heavyTailDelay(2000, { minMs: 1200, maxMs: 2800 });

      const commentEl = await this.findCommentElement(page, commentId);
      if (!commentEl) {
        const session = await this.completeSession({
          preDwellMs,
          readScrollCount,
          trajectorySteps,
          keepPage,
        });
        return {
          success: false,
          action: unlike ? 'unlike' : 'like',
          noteId,
          error: `Comment not found: ${commentId}`,
          session,
        };
      }

      await commentEl.scrollIntoViewIfNeeded();
      await heavyTailDelay(500, { minMs: 300, maxMs: 700 });

      const likeBtn = await commentEl.$('.like .like-wrapper');
      if (!likeBtn) {
        const session = await this.completeSession({
          preDwellMs,
          readScrollCount,
          trajectorySteps,
          keepPage,
        });
        return {
          success: false,
          action: unlike ? 'unlike' : 'like',
          noteId,
          error: 'Like button not found',
          session,
        };
      }

      const isLiked = await likeBtn.evaluate((el: Element) => {
        const useEl = el.querySelector('use');
        if (!useEl) return false;
        const href = useEl.getAttribute('xlink:href');
        return href === '#liked';
      });

      const shouldClick = (unlike && isLiked) || (!unlike && !isLiked);

      if (shouldClick) {
        await clickWithTrajectory(page, likeBtn);
        trajectorySteps = getLastTrajectoryMeta()?.steps ?? null;
        if (!sessionEnabled) {
          await heavyTailDelay(500, { minMs: 300, maxMs: 700 });
        }
      } else {
        this.logger.info('skipped_already_done', {
          action: unlike ? 'unlike' : 'like',
          noteId,
          commentId,
          shortSession: !!config.antiDetect.alreadyDoneShort?.enabled,
        });
      }

      const session = await this.completeSession({
        preDwellMs,
        readScrollCount,
        trajectorySteps,
        keepPage,
        alreadyDone: !shouldClick,
      });

      if (shouldClick) {
        this.logger.info('interact_success', {
          action: unlike ? 'unlike' : 'like',
          noteId,
          commentId,
          trajectorySteps,
          postStayMs: session.postStayMs,
        });
      }

      return {
        success: true,
        action: unlike ? 'unlike' : 'like',
        noteId,
        alreadyDone: !shouldClick,
        session,
      };
    } catch (error) {
      let session: InteractSessionMeta | undefined;
      if (readingStarted) {
        session = await this.completeSession({
          preDwellMs,
          readScrollCount,
          trajectorySteps,
          keepPage,
        }).catch(() => undefined);
      }
      return {
        success: false,
        action: unlike ? 'unlike' : 'like',
        noteId,
        error: error instanceof Error ? error.message : String(error),
        session,
      };
    } finally {
      await this.retainOrClosePage(page, keepPage);
    }
  }
}
