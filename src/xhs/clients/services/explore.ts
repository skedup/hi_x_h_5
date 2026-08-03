/**
 * @fileoverview Explore service for BrowserClient.
 * 自动化浏览首页，模拟真人行为。
 * @module xhs/clients/services/explore
 */

import { Page } from 'patchright';
import { BrowserContextManager, log } from '../context.js';
import { sleep, typeLikeHuman, jitteredSleep, heavyTailDelay, sampleHeavyTailMs } from '../../utils/index.js';
import { config } from '../../../core/config.js';
import { getDatabase, ExploreSessionResult } from '../../../db/index.js';
import {
  selectNoteToOpen,
  generateComment,
  selectLikeTarget,
  NoteBrief,
  AccountInfo,
} from '../../../core/explore-ai.js';
import { getCooccurrenceGuard, sha256OfText } from '../../../core/antidetect.js';
import { isWriteAllowed, getLiveness } from '../../../core/liveness.js';
import { EXPLORE_SELECTORS } from '../constants.js';

/**
 * Explore 参数
 */
export interface ExploreParams {
  /** 运行时长（秒），默认 60 */
  duration?: number;
  /** 感兴趣的关键词 */
  interests?: string[];
  /** 打开笔记概率，默认 0.5 */
  openRate?: number;
  /** 打开后点赞概率，默认 0.5 */
  likeRate?: number;
  /** 打开后评论概率，默认 0.1 */
  commentRate?: number;
  /** 是否启用跨会话去重，默认 true */
  deduplicate?: boolean;
}

/**
 * Feed 数据结构（从 __INITIAL_STATE__ 读取）
 */
export interface FeedItem {
  id: string;
  xsecToken: string;
  noteCard: {
    displayTitle?: string;
    title?: string;
    type: string;
    interactInfo?: {
      likedCount?: string;
    };
    user?: {
      nickname: string;
      userId: string;
    };
  };
}

/**
 * 评论信息
 */
interface CommentInfo {
  id: string;
  content: string;
  likeCount: string;
  liked: boolean;
}

/**
 * Modal 内笔记详情
 */
interface NoteDetail {
  title: string;
  desc: string;
  comments: CommentInfo[];
}

/**
 * A3（blue-team）：将 getFeeds 提取到的每个 feed 的 xsecToken 绑定到实际执行提取的账号（fail-closed）。
 * 与 tools/content.ts 中 search / list_feeds 的绑定模式一致——explore 提取 feed 即视为该账号
 * 首个占用来源，避免后续任何账号用该 token 发起写操作时无法追溯来源账号。
 * 抽成独立函数便于不依赖真实 Page/DOM 的单测覆盖。
 */
export function bindFeedXsecTokens(feeds: FeedItem[], accountId: string): void {
  const guard = getCooccurrenceGuard();
  for (const feed of feeds) {
    if (feed?.xsecToken) guard.bindXsecSource(feed.xsecToken, accountId);
  }
}

/**
 * Explore service - 自动化浏览首页
 */
export class ExploreService {
  /** 存储每个 session 的 AbortController，用于中途停止 */
  private abortControllers: Map<string, AbortController> = new Map();

  constructor(private ctx: BrowserContextManager) {}

  /**
   * 停止指定的 explore 会话
   * @param sessionId 会话 ID，如果不指定则停止所有会话
   * @returns 被停止的会话 ID 列表
   */
  stopExplore(sessionId?: string): string[] {
    const stoppedSessions: string[] = [];

    if (sessionId) {
      const controller = this.abortControllers.get(sessionId);
      if (controller) {
        controller.abort();
        this.abortControllers.delete(sessionId);
        stoppedSessions.push(sessionId);
        log.info('Explore session stopped', { sessionId });
      }
    } else {
      // 停止所有会话
      for (const [sid, controller] of this.abortControllers) {
        controller.abort();
        stoppedSessions.push(sid);
        log.info('Explore session stopped', { sessionId: sid });
      }
      this.abortControllers.clear();
    }

    return stoppedSessions;
  }

  /**
   * 获取当前正在运行的 explore 会话 ID 列表
   */
  getActiveSessions(): string[] {
    return Array.from(this.abortControllers.keys());
  }

  /**
   * 自动浏览首页
   * 模拟真人行为，根据概率打开笔记、点赞、评论
   */
  async explore(accountId: string, accountName: string, params: ExploreParams = {}): Promise<ExploreSessionResult> {
    const {
      duration = 60,
      interests = [],
      openRate = 0.5,
      likeRate = 0.5,
      commentRate = 0.1,
      deduplicate = true,
    } = params;

    // 账号信息，用于读取 prompt
    const accountInfo: AccountInfo = { id: accountId, name: accountName };
    // 共现守卫单例（R2-3：内部点赞/评论逐动作经配额/去重/xsec/熔断）
    const guard = getCooccurrenceGuard();
    // R3-6：启动前确保已真实采样一次设备在场状态（避免默认 awake 误放行已息屏设备）
    await getLiveness().awaitFirstSample();

    await this.ctx.ensureContext();
    const page = await this.ctx.newPage();
    const db = getDatabase();

    // 创建会话
    const sessionId = db.explore.createSession(accountId, {
      duration,
      interests,
      openRate,
      likeRate,
      commentRate,
    });

    log.info('Starting explore session', { sessionId, duration, interests });

    // 创建 AbortController 用于中途停止
    const abortController = new AbortController();
    this.abortControllers.set(sessionId, abortController);

    // R2-2：启动即采样设备在场状态；息屏/无人值守则拒绝启动长任务浏览（避免无人值守自停写违例）
    if (!isWriteAllowed().allowed) {
      log.warn('设备不在场（息屏/无人值守），拒绝启动浏览会话', { reason: isWriteAllowed().reason });
      abortController.abort();
    }

    // 统计
    let notesSeen = 0;
    let notesOpened = 0;
    let notesLiked = 0;
    let notesCommented = 0;

    // 已看过的笔记 ID（会话内去重，用于统计）
    const seenInSession = new Set<string>();
    // 已打开过的笔记 ID（会话内去重，用于选择）
    const openedInSession = new Set<string>();

    const startTime = Date.now();
    const endTime = startTime + duration * 1000;

    try {
      // 导航到 explore 页面
      log.info('Navigating to explore page');
      await page.goto('https://www.xiaohongshu.com/explore', { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await jitteredSleep(2000);

      // 等待 __INITIAL_STATE__ 加载
      await page.waitForFunction(() => (window as any).__INITIAL_STATE__?.feed?.feeds, {
        timeout: 10000,
      });

      // 主循环
      // 连续未打开计数（用于兜底逻辑）
      let skippedRounds = 0;

      while (Date.now() < endTime) {
        // 检查是否被中途停止
        if (abortController.signal.aborted) {
          log.info('Explore session aborted by user', { sessionId });
          break;
        }

        // R2-2：长任务运行中持续重检设备在场状态（息屏/无人值守即优雅停止，不再只靠 stop_explore）
        if (!isWriteAllowed().allowed) {
          log.warn('设备不在场（息屏/无人值守），停止浏览会话', { reason: isWriteAllowed().reason });
          abortController.abort();
          break;
        }

        // === 随机行为模式 ===
        const behaviorRoll = Math.random();

        // 10% 概率：快速滑过模式（连续滑动，不停顿看）
        if (behaviorRoll < 0.1) {
          log.debug('Behavior: quick scroll mode');
          const quickScrolls = 3 + Math.floor(Math.random() * 3); // 3-5 次
          for (let i = 0; i < quickScrolls; i++) {
            await this.humanScroll(page);
            await heavyTailDelay(350, { minMs: 200, maxMs: 500 }); // B1：快滑步间
          }
          continue;
        }

        // 5% 概率：倒回去看（往上滚一点）
        if (behaviorRoll < 0.15) {
          log.debug('Behavior: scroll back');
          await page.mouse.wheel(0, -(200 + Math.random() * 200));
          await heavyTailDelay(1500, { minMs: 1000, maxMs: 2000 }); // B1：回看停顿
        }

        // 正常滑动 1-3 次
        const scrollCount = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < scrollCount; i++) {
          await this.humanScroll(page);
          await heavyTailDelay(600, { minMs: 400, maxMs: 800 }); // B1：滑动步间
        }

        // 停顿阅读：基准 5s 重尾；10% 概率以 15s 为中位的长停（仍可 abort）
        const isLongPause = Math.random() < 0.1;
        const readingBase = isLongPause ? 15000 : 5000;
        const readingDelay = isLongPause
          ? sampleHeavyTailMs(readingBase, { minMs: 10000, maxMs: 20000 })
          : sampleHeavyTailMs(readingBase, { minMs: 3000, maxMs: 8000 });
        if (isLongPause) {
          log.debug('Behavior: long pause');
        }
        // R3-6：长等待可被 abort（息屏/stop）中断，尽快终止当前迭代
        await this.sleepAbortable(readingDelay, abortController.signal);

        // 获取当前 feeds，过滤已看过的（用于统计）
        const feeds = await this.getFeeds(page);
        // A3（blue-team）：提取 feed 即绑定 xsecToken 来源账号，不等到真正点赞/评论才 bind，
        // 确保「探索式提取」与 search/list_feeds 一致地 fail-closed 占用来源。
        bindFeedXsecTokens(feeds, accountId);
        const newFeeds = feeds.filter((f) => {
          if (seenInSession.has(f.id)) return false;
          if (f.noteCard.type === 'video') return false; // 跳过视频
          return true;
        });

        // 标记为已看
        for (const feed of newFeeds) {
          seenInSession.add(feed.id);
        }

        // 记录到数据库（仅用于日志，不标记为 explored）
        // explored 标记只在真正互动（点赞/评论）后才设置，用于跨会话去重
        if (newFeeds.length > 0) {
          notesSeen += newFeeds.length;
          db.explore.logSeenNotes(
            sessionId,
            newFeeds.map((f) => ({
              id: f.id,
              title: f.noteCard.displayTitle || f.noteCard.title || '',
            })),
          );
        }

        log.debug('Feeds after scroll', { total: feeds.length, new: newFeeds.length });

        // === 决定是否打开笔记 ===
        // 连续跳过多轮后概率递增（兜底逻辑）
        const adjustedOpenRate = Math.min(openRate + skippedRounds * 0.1, 0.9);

        if (Math.random() < adjustedOpenRate) {
          // 获取当前 DOM 中可见的笔记 ID
          const visibleIds = await this.getVisibleNoteIds(page);
          log.debug('Visible notes in DOM', { count: visibleIds.size });

          // 从可见笔记中筛选：排除会话内已打开、视频
          let candidateFeeds = feeds.filter(
            (f) => visibleIds.has(f.id) && !openedInSession.has(f.id) && f.noteCard.type !== 'video',
          );

          // 跨会话去重：排除之前互动过的笔记
          if (deduplicate && candidateFeeds.length > 0) {
            const candidateIds = candidateFeeds.map((f) => f.id);
            const unexploredIds = db.explore.filterUnexploredNotes(accountId, candidateIds);
            const unexploredSet = new Set(unexploredIds);
            const beforeCount = candidateFeeds.length;
            candidateFeeds = candidateFeeds.filter((f) => unexploredSet.has(f.id));
            if (beforeCount !== candidateFeeds.length) {
              log.debug('Cross-session dedup', { before: beforeCount, after: candidateFeeds.length });
            }
          }

          log.debug('Candidate feeds for opening', { count: candidateFeeds.length });

          if (candidateFeeds.length === 0) {
            log.debug('No candidate feeds to open');
            skippedRounds++;
            continue;
          }

          // 调用 AI 选择一篇
          const noteBriefs: NoteBrief[] = candidateFeeds.slice(0, 10).map((f) => ({
            id: f.id,
            title: f.noteCard.displayTitle || f.noteCard.title || '',
            likes: f.noteCard.interactInfo?.likedCount || '0',
            type: f.noteCard.type,
          }));

          const selection = await selectNoteToOpen(accountInfo, noteBriefs, interests);

          if (selection.noteId) {
            skippedRounds = 0; // 重置跳过计数
            const selectedFeed = candidateFeeds.find((f) => f.id === selection.noteId);
            if (selectedFeed) {
              log.info('AI selected note', { noteId: selection.noteId, reason: selection.reason });

              // 标记为已打开
              openedInSession.add(selectedFeed.id);

              // 记录 opened
              db.explore.logAction(sessionId, {
                noteId: selectedFeed.id,
                noteTitle: selectedFeed.noteCard.displayTitle || selectedFeed.noteCard.title,
                action: 'opened',
                aiReason: selection.reason,
              });
              notesOpened++;

              // 打开 modal
              const opened = await this.openNoteModal(page, selectedFeed.id);

              if (opened) {
                // 15% 概率快速关掉（假装不感兴趣）
                if (Math.random() < 0.15) {
                  log.debug('Behavior: quick close (not interested)');
                  await heavyTailDelay(1150, { minMs: 800, maxMs: 1500 });
                  await this.closeModal(page);
                  await heavyTailDelay(750, { minMs: 500, maxMs: 1000 });
                  continue;
                }

                // 正常阅读：基准 5s 重尾；10% 深度阅读以 15s 为中位
                const isDeepRead = Math.random() < 0.1;
                const modalReadBase = isDeepRead ? 15000 : 5000;
                const modalReadDelay = isDeepRead
                  ? sampleHeavyTailMs(modalReadBase, { minMs: 10000, maxMs: 20000 })
                  : sampleHeavyTailMs(modalReadBase, { minMs: 3000, maxMs: 8000 });
                if (isDeepRead) {
                  log.debug('Behavior: deep reading');
                }
                // R3-6：长等待可被 abort（息屏/stop）中断，尽快终止当前迭代
                await this.sleepAbortable(modalReadDelay, abortController.signal);

                // 获取笔记详情（包含评论）
                const noteDetail = await this.getNoteDetailFromModal(page, selectedFeed.id);

                // 按概率决定是否点赞（使用 AI 选择点赞帖子还是评论）
                if (Math.random() < likeRate && noteDetail) {
                  // R3-6：每个写动作前统一检查 abort + 设备在场，不在场则跳过本动作
                  const canLike = this.assertCanWrite(abortController);
                  if (!canLike.ok) {
                    log.warn('explore 点赞前门禁未过，跳过', { noteId: selectedFeed.id, reason: canLike.reason });
                  } else {
                  const likeTarget = await selectLikeTarget(
                    accountInfo,
                    noteDetail.title,
                    noteDetail.desc,
                    noteDetail.comments,
                  );

                  if (likeTarget.target === 'post') {
                    // R2-3：内部写操作经共现守卫（配额/去重/xsec/熔断），逐动作策略
                    // A2：键空间与 tools/interaction.ts 的 xhs_like_feed 统一（like:note:${noteId}），
                    // 使工具赞与 explore 赞跨路径互斥
                    const resv = await guard.beforeAction({
                      accountId,
                      action: 'like',
                      dedupKey: `like:note:${selectedFeed.id}`,
                      xsecToken: selectedFeed.xsecToken,
                    });
                    if (!resv.allow) {
                      log.warn('explore 内部点赞被共现守卫拦截', { noteId: selectedFeed.id, reason: resv.reason });
                    } else {
                      // R4 P1 1019834745：取得 reservation 后、真正 DOM 写前再次检查设备在场，
                      // 覆盖 selectLikeTarget（AI 异步）期间息屏的窗口；不在场则回滚 reservation 跳过写。
                      const canWrite = this.assertCanWrite(abortController);
                      if (!canWrite.ok) {
                        await guard.cancelReservation(resv.reservation, accountId);
                        log.warn('explore 点赞前写门禁未过，回滚 reservation 跳过', { noteId: selectedFeed.id, reason: canWrite.reason });
                      } else {
                        // 点赞帖子
                        const liked = await this.likeInModal(page);
                        if (liked) {
                          db.explore.logAction(sessionId, {
                            noteId: selectedFeed.id,
                            noteTitle: selectedFeed.noteCard.displayTitle,
                            action: 'liked',
                            aiReason: likeTarget.reason,
                          });
                          notesLiked++;
                          db.explore.markNoteExplored(accountId, selectedFeed.id, true);
                          log.info('Liked note', { noteId: selectedFeed.id, reason: likeTarget.reason });
                        }
                        await guard.afterAction({
                          accountId,
                          action: 'like',
                          success: liked,
                          dedupKey: `like:note:${selectedFeed.id}`,
                          xsecToken: selectedFeed.xsecToken,
                          reservation: resv.reservation,
                        });
                      }
                    }
                  } else if (likeTarget.target.startsWith('comment:')) {
                    // 点赞评论
                    const commentId = likeTarget.target.replace('comment:', '');
                    // A2：键空间与 tools/interaction.ts 的 xhs_like_comment 统一（like_c:${noteId}:${commentId}）
                    const resv = await guard.beforeAction({
                      accountId,
                      action: 'like_comment',
                      dedupKey: `like_c:${selectedFeed.id}:${commentId}`,
                      xsecToken: selectedFeed.xsecToken,
                    });
                    if (!resv.allow) {
                      log.warn('explore 内部点赞评论被共现守卫拦截', { noteId: selectedFeed.id, commentId, reason: resv.reason });
                    } else {
                      // R4 P1 1019834745：写前再次检查设备在场
                      const canWrite = this.assertCanWrite(abortController);
                      if (!canWrite.ok) {
                        await guard.cancelReservation(resv.reservation, accountId);
                        log.warn('explore 点赞评论前写门禁未过，回滚 reservation 跳过', { noteId: selectedFeed.id, commentId, reason: canWrite.reason });
                      } else {
                        const liked = await this.likeCommentInModal(page, commentId);
                        if (liked) {
                          db.explore.logAction(sessionId, {
                            noteId: selectedFeed.id,
                            noteTitle: selectedFeed.noteCard.displayTitle,
                            action: 'liked',
                            content: `评论: ${commentId}`,
                            aiReason: likeTarget.reason,
                          });
                          notesLiked++;
                          db.explore.markNoteExplored(accountId, selectedFeed.id, true);
                          log.info('Liked comment', { noteId: selectedFeed.id, commentId, reason: likeTarget.reason });
                        }
                        await guard.afterAction({
                          accountId,
                          action: 'like_comment',
                          success: liked,
                          dedupKey: `like_c:${selectedFeed.id}:${commentId}`,
                          xsecToken: selectedFeed.xsecToken,
                          reservation: resv.reservation,
                        });
                      }
                    }
                  } else {
                    log.debug('AI chose not to like', { reason: likeTarget.reason });
                  }
                  }
                }

                // 按概率评论
                if (Math.random() < commentRate && noteDetail) {
                  // R3-6：每个写动作前统一检查 abort + 设备在场，不在场则跳过本动作
                  const canComment = this.assertCanWrite(abortController);
                  if (!canComment.ok) {
                    log.warn('explore 评论前门禁未过，跳过', { noteId: selectedFeed.id, reason: canComment.reason });
                  } else {
                  const commentResult = await generateComment(accountInfo, noteDetail.title, noteDetail.desc);
                  // 蓝军 A4：AI 生成失败/解析失败时 skip=true，禁止用固定兜底文案发评论，
                  // 也不得进入共现守卫预占或计入 notesCommented。
                  if (commentResult.skip || !commentResult.comment) {
                    log.debug('AI 未生成有效评论，跳过本次评论', { noteId: selectedFeed.id });
                  } else {
                    const commentText = commentResult.comment;
                    // 蓝军 A4：与 tools/interaction.ts 的 xhs_post_comment 使用同一前缀的正文哈希键，
                    // 使 explore 内部评论与工具评论对相同文案跨账号互斥。
                    const dedupKey = `comment_text:${sha256OfText(commentText)}`;
                    // R2-3：内部写操作经共现守卫（配额/去重/xsec/熔断）
                    const resv = await guard.beforeAction({
                      accountId,
                      action: 'comment',
                      dedupKey,
                      xsecToken: selectedFeed.xsecToken,
                    });
                    if (!resv.allow) {
                      log.warn('explore 内部评论被共现守卫拦截', { noteId: selectedFeed.id, reason: resv.reason });
                    } else {
                      // R4 P1 1019834745：写前再次检查设备在场（覆盖 generateComment 异步窗口）
                      const canWrite = this.assertCanWrite(abortController);
                      if (!canWrite.ok) {
                        await guard.cancelReservation(resv.reservation, accountId);
                        log.warn('explore 评论前写门禁未过，回滚 reservation 跳过', { noteId: selectedFeed.id, reason: canWrite.reason });
                      } else {
                        const commented = await this.commentInModal(page, commentText);
                        if (commented) {
                          db.explore.logAction(sessionId, {
                            noteId: selectedFeed.id,
                            noteTitle: selectedFeed.noteCard.displayTitle,
                            action: 'commented',
                            content: commentText,
                          });
                          notesCommented++;
                          db.explore.markNoteExplored(accountId, selectedFeed.id, true);
                          log.info('Commented on note', { noteId: selectedFeed.id, comment: commentText });
                        }
                        await guard.afterAction({
                          accountId,
                          action: 'comment',
                          success: commented,
                          dedupKey,
                          xsecToken: selectedFeed.xsecToken,
                          reservation: resv.reservation,
                        });
                      }
                    }
                  }
                  }
                }

                // 关闭 modal，随机停顿（B1 重尾）
                await this.closeModal(page);
                await heavyTailDelay(1500, { minMs: 800, maxMs: 2300 });
              }
            }
          } else {
            log.debug('AI chose not to open any note', { reason: selection.reason });
            skippedRounds++;
          }
        } else {
          skippedRounds++;
        }

        // 更新统计
        db.explore.updateSessionStats(sessionId, {
          notesSeen,
          notesOpened,
          notesLiked,
          notesCommented,
        });
      }

      // 结束会话
      const endStatus = abortController.signal.aborted ? 'stopped' : 'completed';
      db.explore.endSession(sessionId, endStatus);
      log.info('Explore session ended', { status: endStatus, notesSeen, notesOpened, notesLiked, notesCommented });
    } catch (error) {
      log.error('Explore error', { error });
      db.explore.endSession(sessionId, 'stopped');
    } finally {
      // 清理 AbortController
      this.abortControllers.delete(sessionId);

      // keepOpen 模式下保持浏览器打开
      if (!config.browser.keepOpen) {
        await page.close();
      } else {
        log.info('Keep open mode: browser stays open');
      }
    }

    // 返回会话结果
    return db.explore.getSessionResult(sessionId)!;
  }

  /**
   * R3-6：每个写动作前统一检查 abort + 设备在场；不在场则终止该会话并跳过写。
   */
  private assertCanWrite(abortController: AbortController): { ok: boolean; reason?: string } {
    if (abortController.signal.aborted) return { ok: false, reason: 'aborted' };
    const live = isWriteAllowed();
    if (!live.allowed) {
      log.warn('设备不在场（息屏/无人值守），停止浏览会话', { reason: live.reason });
      abortController.abort();
      return { ok: false, reason: live.reason };
    }
    return { ok: true };
  }

  /**
   * R3-6：可中断的 sleep；abort 时立即返回，使息屏/stop 能尽快终止当前迭代中的长等待。
   */
  private sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort);
    });
  }

  /**
   * 模拟人类滚动
   */
  private async humanScroll(page: Page): Promise<void> {
    const distance = 300 + Math.random() * 400;
    const steps = 5 + Math.floor(Math.random() * 5);

    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, distance / steps);
      await heavyTailDelay(50, { minMs: 20, maxMs: 80 }); // B1：滚轮步间
    }
  }

  /**
   * 从页面获取 feeds
   */
  private async getFeeds(page: Page): Promise<FeedItem[]> {
    try {
      const feedsJson = await page.evaluate(
        () => {
          const state = (window as any).__INITIAL_STATE__;
          if (state?.feed?.feeds) {
            const feeds = state.feed.feeds;
            const feedsData = feeds.value !== undefined ? feeds.value : feeds._value || feeds;
            if (Array.isArray(feedsData)) {
              return JSON.stringify(feedsData);
            }
          }
          return '[]';
        },
        null,
        false,
      );
      return JSON.parse(feedsJson);
    } catch (error) {
      log.warn('Failed to get feeds', { error });
      return [];
    }
  }

  /**
   * 获取当前 DOM 中可见的笔记 ID 列表
   * 小红书使用虚拟滚动，只有可见区域的笔记才有 DOM 元素
   */
  private async getVisibleNoteIds(page: Page): Promise<Set<string>> {
    try {
      const ids = await page.$$eval(EXPLORE_SELECTORS.noteCover, (els) =>
        els
          .map((el) => {
            const href = el.getAttribute('href') || '';
            // 从 href 中提取 noteId，格式如 /explore/xxx?xsec_token=...
            const match = href.match(/\/explore\/([a-f0-9]+)/);
            return match ? match[1] : '';
          })
          .filter(Boolean),
      );
      return new Set(ids);
    } catch (error) {
      log.warn('Failed to get visible note IDs', { error });
      return new Set();
    }
  }

  /**
   * 打开笔记 modal
   */
  private async openNoteModal(page: Page, noteId: string): Promise<boolean> {
    try {
      // 查找笔记封面（可点击的 a.cover 元素）
      const coverSelector = `${EXPLORE_SELECTORS.noteCover}[href*="${noteId}"]`;
      const cover = await page.$(coverSelector);

      if (!cover) {
        log.warn('Note cover not found', { noteId });
        return false;
      }

      // 先滚动到可见区域
      await cover.scrollIntoViewIfNeeded();
      await heavyTailDelay(300, { minMs: 180, maxMs: 420 });

      // 真实鼠标点击（force 跳过可操作性断言但仍是 CDP 真实事件，isTrusted=true，规避 el.click() 的 isTrusted=false）
      await cover.click({ force: true });
      await heavyTailDelay(500, { minMs: 300, maxMs: 700 });

      // 等待 modal 出现
      await page.waitForSelector(EXPLORE_SELECTORS.noteContainer, { timeout: 5000 });
      log.info('Modal opened', { noteId });
      return true;
    } catch (error) {
      log.warn('Failed to open modal', { noteId, error });
      return false;
    }
  }

  /**
   * 从 modal 获取笔记详情（包含评论）
   */
  private async getNoteDetailFromModal(page: Page, noteId: string): Promise<NoteDetail | null> {
    try {
      const detailJson = await page.evaluate(
        (id) => {
          const state = (window as any).__INITIAL_STATE__;
          const noteMap = state?.note?.noteDetailMap;
          if (noteMap) {
            const mapData = noteMap.value !== undefined ? noteMap.value : noteMap._value || noteMap;
            // 找到正确的 key（跳过 undefined）
            const actualId = Object.keys(mapData).find((k) => k !== 'undefined' && k === id) || id;
            const detail = mapData[actualId];
            if (detail) {
              const note = detail.note || detail;
              // 提取评论列表（前 10 条）
              const commentList = detail.comments?.list || [];
              const comments = commentList.slice(0, 10).map((c: any) => ({
                id: c.id || '',
                content: c.content || '',
                likeCount: c.likeCount || '0',
                liked: !!c.liked,
              }));
              return JSON.stringify({
                title: note.title || '',
                desc: note.desc || '',
                comments,
              });
            }
          }
          return null;
        },
        noteId,
        false,
      );

      return detailJson ? JSON.parse(detailJson) : null;
    } catch (error) {
      log.warn('Failed to get note detail', { noteId, error });
      return null;
    }
  }

  /**
   * 在 modal 内点赞
   */
  private async likeInModal(page: Page): Promise<boolean> {
    try {
      const likeBtn = await page.$(EXPLORE_SELECTORS.likeWrapper);
      if (!likeBtn) {
        log.warn('Like button not found in modal');
        return false;
      }

      // 检查是否已点赞（通过 SVG use 的 xlink:href 判断，#like=未点赞，#liked=已点赞）
      const isLiked = await likeBtn.evaluate((el: Element) => {
        const useEl = el.querySelector('use');
        if (!useEl) return false;
        const href = useEl.getAttribute('xlink:href');
        return href === '#liked';
      });
      if (isLiked) {
        log.debug('Already liked');
        return false;
      }

      // 点赞
      await likeBtn.click();
      await heavyTailDelay(500, { minMs: 300, maxMs: 700 });
      return true;
    } catch (error) {
      log.warn('Failed to like in modal', { error });
      return false;
    }
  }

  /**
   * 在 modal 内点赞评论
   * @param commentId 评论 ID
   */
  private async likeCommentInModal(page: Page, commentId: string): Promise<boolean> {
    try {
      // 找到评论元素
      const commentSelector = `#comment-${commentId}`;
      const commentEl = await page.$(commentSelector);
      if (!commentEl) {
        log.warn('Comment not found', { commentId });
        return false;
      }

      // 找到评论的点赞按钮
      const likeBtn = await commentEl.$('.like-wrapper');
      if (!likeBtn) {
        log.warn('Comment like button not found', { commentId });
        return false;
      }

      // 检查是否已点赞
      const isLiked = await likeBtn.evaluate((el: Element) => {
        const useEl = el.querySelector('use');
        if (!useEl) return false;
        const href = useEl.getAttribute('xlink:href');
        return href === '#liked';
      });
      if (isLiked) {
        log.debug('Comment already liked', { commentId });
        return false;
      }

      // 点赞
      await likeBtn.click();
      await heavyTailDelay(500, { minMs: 300, maxMs: 700 });
      log.debug('Liked comment', { commentId });
      return true;
    } catch (error) {
      log.warn('Failed to like comment', { commentId, error });
      return false;
    }
  }

  /**
   * 在 modal 内评论
   */
  private async commentInModal(page: Page, content: string): Promise<boolean> {
    try {
      // 点击评论输入区域
      const inputArea = await page.$(EXPLORE_SELECTORS.commentInputArea);
      if (!inputArea) {
        log.warn('Comment input area not found');
        return false;
      }

      await inputArea.click();
      await heavyTailDelay(500, { minMs: 300, maxMs: 700 });

      // 输入评论内容
      const commentInput = await page.$(EXPLORE_SELECTORS.commentInput);
      if (!commentInput) {
        log.warn('Comment input not found');
        return false;
      }

      await commentInput.click();
      await typeLikeHuman(page, content);

      await heavyTailDelay(500, { minMs: 300, maxMs: 700 });

      // 点击提交按钮
      const submitBtn = await page.$(EXPLORE_SELECTORS.commentSubmit);
      if (!submitBtn) {
        log.warn('Submit button not found');
        return false;
      }

      await submitBtn.click();
      await jitteredSleep(2000);
      return true;
    } catch (error) {
      log.warn('Failed to comment in modal', { error });
      return false;
    }
  }

  /**
   * 关闭 modal
   */
  private async closeModal(page: Page): Promise<void> {
    try {
      // 点击关闭按钮
      const closeBtn = await page.$(EXPLORE_SELECTORS.closeButton);
      if (closeBtn) {
        await closeBtn.click();
        await heavyTailDelay(500, { minMs: 300, maxMs: 700 });
        return;
      }

      // 备选：按 ESC
      await page.keyboard.press('Escape');
      await heavyTailDelay(500, { minMs: 300, maxMs: 700 });
    } catch (error) {
      log.warn('Failed to close modal', { error });
      // 尝试按 ESC
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
}
