/**
 * @fileoverview Publishing service for BrowserClient.
 * Contains methods for publishing images and videos.
 * @module xhs/clients/services/publish
 */

import { Locator, Page } from 'patchright';
import { PublishContentParams, PublishVideoParams, PublishResult } from '../../types.js';
import { sleep, resolveImagePaths, isHttpUrl, typeLikeHuman, jitteredSleep, type TypeLikeHumanOptions } from '../../utils/index.js';
import { config } from '../../../core/config.js';
import { BrowserContextManager, log } from '../context.js';
import { TIMEOUTS, PUBLISH_SELECTORS, URLS } from '../constants.js';

/** 平台标题长度上限（小红书标题 ≤ 20 字） */
const PUBLISH_TITLE_MAX = 20;
/** 平台正文长度上限（小红书正文 ≤ 1000 字） */
const PUBLISH_CONTENT_MAX = 1000;

/**
 * Publish service - handles content publishing
 */
export class PublishService {
  constructor(private ctx: BrowserContextManager) {}

  /**
   * Publish an image/text note.
   * Opens a visible browser window for the publishing process.
   *
   * @param params - Publishing parameters
   * @returns Publish result with success status
   */
  async publishContent(params: PublishContentParams): Promise<PublishResult> {
    log.info('Starting publishContent', { title: params.title, imageCount: params.images.length });

    if (!this.ctx.options.state) {
      log.error('Not logged in');
      return { success: false, error: 'Not logged in. Please use xhs_add_account first.' };
    }

    // 处理 HTTP URL 图片：下载到本地临时目录
    let imagePaths = params.images;
    const hasHttpUrls = params.images.some((p) => isHttpUrl(p));
    if (hasHttpUrls) {
      log.info('Detected HTTP image URLs, downloading to local...');
      try {
        imagePaths = await resolveImagePaths(params.images);
        log.info('HTTP images downloaded', { count: imagePaths.length });
      } catch (error) {
        log.error('Failed to download HTTP images', { error: error instanceof Error ? error.message : String(error) });
        return {
          success: false,
          error: `Failed to download HTTP images: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    await this.ctx.close();
    const context = await this.ctx.ensureContext(config.browser.headless);
    const page = await context.newPage();

    try {
      // Navigate to creator publish page (matching Go project URL)
      log.info('Navigating to creator publish page', { url: URLS.PUBLISH });
      await page.goto(URLS.PUBLISH, {
        waitUntil: 'load',
        timeout: TIMEOUTS.PAGE_LOAD,
      });

      // Wait for page to stabilize (matching Go project: WaitLoad + 2 seconds)
      log.debug('Waiting for page to stabilize...');
      await jitteredSleep(2000);

      // 等待网络空闲，超时则继续
      try {
        await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.NETWORK_IDLE });
      } catch {
        log.warn('Network idle timeout, continuing...');
      }
      await jitteredSleep(1000);

      // 检查是否被重定向到登录页面
      const currentUrl = page.url();
      log.debug('Current URL after navigation', { url: currentUrl });

      if (currentUrl.includes('login') || currentUrl.includes('passport')) {
        log.error('Redirected to login page - session invalid');
        return { success: false, error: 'Session expired. Please re-login with xhs_add_account.' };
      }

      // 等待上传内容区域出现
      log.debug('Waiting for upload content area...');
      try {
        await page.waitForSelector('div.upload-content', { timeout: TIMEOUTS.UPLOAD_CONTENT });
        log.debug('Upload content area found');
      } catch (e) {
        log.error('Upload content area not found', { error: e });
        const pageTitle = await page.title();
        log.error('Page info', { title: pageTitle, url: page.url() });
        return { success: false, error: `Publish page not loaded correctly. Title: ${pageTitle}` };
      }

      // Click image upload tab (matching Go project: mustClickPublishTab)
      log.debug('Clicking upload image tab...');
      await this.clickPublishTab(page, '上传图文');
      await jitteredSleep(1000);

      // Upload images
      log.debug('Looking for upload input...');
      const uploadInput = await page.$(PUBLISH_SELECTORS.uploadInput);
      if (!uploadInput) {
        log.error('Upload input not found');
        return { success: false, error: 'Upload input not found' };
      }

      // Validate image paths
      const validPaths: string[] = [];
      for (const imgPath of imagePaths) {
        try {
          const fs = await import('fs');
          if (fs.existsSync(imgPath)) {
            validPaths.push(imgPath);
            log.debug('Valid image path', { path: imgPath });
          } else {
            log.warn('Image file not found', { path: imgPath });
          }
        } catch {
          validPaths.push(imgPath); // Let Playwright handle the error
        }
      }

      if (validPaths.length === 0) {
        log.error('No valid image paths');
        return { success: false, error: 'No valid image files found' };
      }

      // Set files
      log.info('Uploading images', { count: validPaths.length });
      await uploadInput.setInputFiles(validPaths);

      // Wait for upload complete (matching Go project: waitForUploadComplete)
      log.debug('Waiting for upload complete...');
      await this.waitForUploadComplete(page, validPaths.length);
      await jitteredSleep(2000);

      // Fill title（恢复"替换"语义 + 长度上限 + 软上限防锁阻塞）
      log.debug('Filling title...');
      const title = (params.title ?? '').slice(0, PUBLISH_TITLE_MAX);
      if (title.length < (params.title ?? '').length) {
        log.warn('Title truncated to platform limit', { limit: PUBLISH_TITLE_MAX });
      }
      const titleInput = page.locator(PUBLISH_SELECTORS.titleInput).first();
      if ((await titleInput.count()) > 0) {
        await this.fillFieldLikeHuman(
          page,
          titleInput,
          title,
          { reviseEvery: 4, reviseMax: 1, maxDurationMs: 20000 },
          false,
        );
        log.info('Title set', { title });
      } else {
        log.warn('Title input not found');
      }

      // Fill content（恢复"替换"语义 + 长度上限 + 软上限防锁阻塞）
      log.debug('Filling content...');
      const content = (params.content ?? '').slice(0, PUBLISH_CONTENT_MAX);
      if (content.length < (params.content ?? '').length) {
        log.warn('Content truncated to platform limit', { limit: PUBLISH_CONTENT_MAX });
      }
      const contentEditor = page.locator(PUBLISH_SELECTORS.contentEditor).first();
      if ((await contentEditor.count()) > 0) {
        await this.fillFieldLikeHuman(
          page,
          contentEditor,
          content,
          { reviseEvery: 6, reviseMax: 1, maxDurationMs: 60000 },
          true,
        );
        log.info('Content set');
      } else {
        const contentTextbox = page.locator(PUBLISH_SELECTORS.contentTextbox).first();
        if ((await contentTextbox.count()) > 0) {
          await this.fillFieldLikeHuman(
            page,
            contentTextbox,
            content,
            { reviseEvery: 6, reviseMax: 1, maxDurationMs: 60000 },
            true,
          );
          log.info('Content set (via textbox)');
        } else {
          log.warn('Content editor not found');
        }
      }

      await jitteredSleep(1000);

      // Add tags
      if (params.tags && params.tags.length > 0) {
        log.debug('Adding tags', { tags: params.tags });
        for (const tag of params.tags) {
          await typeLikeHuman(page, `#${tag}`);
          await jitteredSleep(500);

          // Wait for and click tag suggestion
          const suggestion = await page.$(`${PUBLISH_SELECTORS.topicContainer}:has-text("${tag}")`);
          if (suggestion) {
            await suggestion.click();
            await jitteredSleep(300);
          } else {
            // Press space to confirm tag
            await page.keyboard.press('Space');
          }
          await jitteredSleep(300);
        }
        log.info('Tags added');
      }

      // Handle scheduled publish
      if (params.scheduleTime) {
        log.debug('Setting schedule time', { time: params.scheduleTime });
        const scheduleRadio = await page.$(PUBLISH_SELECTORS.scheduleRadio);
        if (scheduleRadio) {
          await scheduleRadio.click();
          await jitteredSleep(500);
          log.warn('Schedule time selection not fully implemented', { time: params.scheduleTime });
        }
      }

      // Click publish button
      log.info('Clicking publish button...');
      const publishBtn = await this.resolvePublishButton(page);
      if (!publishBtn) {
        return { success: false, error: 'A unique enabled publish button was not found' };
      }

      await publishBtn.click();
      log.info('Publish button clicked');

      return await this.waitForPublishOutcome(page);
    } catch (error) {
      log.error('Publish failed', { error: error instanceof Error ? error.message : String(error) });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        sideEffectPossible: true,
      };
    } finally {
      if (config.browser.keepOpen) {
        log.info('Keep open mode: publish page stays open for operator inspection');
      } else {
        await jitteredSleep(2000);
        await page.close();
        log.debug('Browser page closed');
      }
    }
  }

  /**
   * 拟人化填入字段，并恢复"替换"语义（修复 P1：标题/正文从替换退化为追加）。
   * - 输入前全选清空，避免把内容追加到残留/草稿文本之后；
   * - 输入后校验最终值，不匹配仅告警不阻断（contenteditable 取值含格式噪声）。
   *
   * @param locator 目标字段（input 或 contenteditable）
   * @param text 要键入的内容（调用方需已做长度裁剪）
   * @param options typeLikeHuman 选项（reviseEvery / maxDurationMs / signal）
   * @param isContentEditable 是否 contenteditable（影响取值与断言方式）
   */
  private async fillFieldLikeHuman(
    page: Page,
    locator: Locator,
    text: string,
    options: TypeLikeHumanOptions,
    isContentEditable: boolean,
  ): Promise<void> {
    await locator.click();
    // 恢复"替换"语义：全选并删除已有内容
    await page.keyboard.press('Control+A');
    await sleep(30);
    await page.keyboard.press('Backspace');
    await sleep(30);

    // 断言已清空；未清空则兜底再清一次（contenteditable 场景更稳）
    const before = isContentEditable
      ? ((await locator.textContent().catch(() => '')) ?? '')
      : (await locator.inputValue().catch(() => ''));
    if (before.trim().length > 0) {
      await locator.click({ clickCount: 3 }).catch(() => {});
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await sleep(30);
    }

    await typeLikeHuman(page, text, options);

    // 输入后校验最终值
    const after = isContentEditable
      ? ((await locator.textContent().catch(() => text)) ?? text)
      : (await locator.inputValue().catch(() => text));
    if (after !== text) {
      log.warn('field value mismatch after typing (possible residual/IME artifact)', {
        expectedLen: text.length,
        actualLen: after.length,
      });
    }
  }

  private async resolvePublishButton(page: Page): Promise<Locator | null> {
    const candidates = page.getByRole('button', { name: '发布', exact: true });
    const candidateCount = await candidates.count();
    const visible: Locator[] = [];
    for (let index = 0; index < candidateCount; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
    }
    log.info('Publish button candidates resolved', {
      candidateCount,
      visibleCount: visible.length,
    });
    if (visible.length !== 1 || !(await visible[0].isEnabled().catch(() => false))) {
      log.error('Unique enabled publish button not found', {
        candidateCount,
        visibleCount: visible.length,
      });
      return null;
    }
    return visible[0];
  }

  private async waitForPublishOutcome(page: Page): Promise<PublishResult> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const resultUrl = page.url();
      const noteIdMatch = resultUrl.match(/\/(?:note|explore)\/([a-zA-Z0-9]+)/);
      const successVisible = await page
        .getByText('发布成功', { exact: true })
        .first()
        .isVisible()
        .catch(() => false);
      if (resultUrl.includes('success') || noteIdMatch || successVisible) {
        log.info('Publish successful', { noteId: noteIdMatch?.[1] });
        return { success: true, noteId: noteIdMatch?.[1] };
      }

      const parsedUrl = new URL(resultUrl);
      const route = `${parsedUrl.pathname}${parsedUrl.search}`;
      const draftRoute = /(?:^|[/?#&=_-])draft(?:s|box)?(?:$|[/?#&=_-])/i.test(route);
      const draftNoticeVisible = await page
        .getByText(/已(?:保存|存入)(?:至|到)?草稿箱/)
        .first()
        .isVisible()
        .catch(() => false);
      const draftBoxVisible = await page
        .getByText('草稿箱', { exact: true })
        .first()
        .isVisible()
        .catch(() => false);
      const editorVisible = await page
        .locator(PUBLISH_SELECTORS.titleInput)
        .first()
        .isVisible()
        .catch(() => false);
      if (draftRoute || draftNoticeVisible || (draftBoxVisible && !editorVisible)) {
        log.warn('Publish was saved as a draft instead of being published');
        return { success: false, error: 'Content was saved as a draft' };
      }

      const failureVisible = await page
        .getByText(/发布失败|发布受限|暂时无法发布|请稍后重试/)
        .first()
        .isVisible()
        .catch(() => false);
      if (failureVisible) {
        log.warn('Publish was rejected by the page');
        return { success: false, error: 'Publish was rejected by the page' };
      }
      await jitteredSleep(500);
    }

    log.warn('Publish outcome could not be confirmed');
    return {
      success: false,
      error: 'Publish outcome unconfirmed',
      sideEffectPossible: true,
    };
  }

  /**
   * Click publish tab (matching Go project: mustClickPublishTab)
   */
  private async clickPublishTab(page: Page, tabName: string): Promise<void> {
    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {
      const tabs = await page.$$('div.creator-tab');

      for (const tab of tabs) {
        const text = await tab.textContent();
        if (text?.trim() === tabName) {
          // Check if tab is blocked by overlay
          const isBlocked = await tab.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return true;
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const target = document.elementFromPoint(x, y);
            return !(target === el || el.contains(target));
          });

          if (isBlocked) {
            log.debug('Tab is blocked, trying to remove overlay...');
            // Try to click empty area to dismiss popover
            await page.mouse.click(400, 50);
            await jitteredSleep(200);
            continue;
          }

          await tab.click();
          log.debug('Clicked publish tab', { tabName });
          return;
        }
      }

      await jitteredSleep(200);
    }

    log.warn('Publish tab not found', { tabName });
  }

  /**
   * 等待图片上传完成
   *
   * 通过检测上传预览区域的图片数量来判断上传是否完成。
   *
   * @param page - Playwright 页面实例
   * @param expectedCount - 期望上传的图片数量
   */
  private async waitForUploadComplete(page: Page, expectedCount: number): Promise<void> {
    const checkInterval = 500;
    const startTime = Date.now();

    log.debug('Waiting for upload complete', { expectedCount });

    while (Date.now() - startTime < TIMEOUTS.IMAGE_UPLOAD) {
      // 检查已上传的图片数量
      const uploadedImages = await page.$$('.img-preview-area .pr');
      const currentCount = uploadedImages.length;

      log.debug('Upload progress', { current: currentCount, expected: expectedCount });

      if (currentCount >= expectedCount) {
        log.info('All images uploaded', { count: currentCount });
        return;
      }

      await sleep(checkInterval);
    }

    log.warn('Upload timeout, continuing anyway');
  }

  /**
   * Publish a video note.
   * Opens a visible browser window for the publishing process.
   *
   * @param params - Publishing parameters
   * @returns Publish result with success status
   */
  async publishVideo(params: PublishVideoParams): Promise<PublishResult> {
    if (!this.ctx.options.state) {
      return { success: false, error: 'Not logged in. Please use xhs_login first.' };
    }

    await this.ctx.close();
    const context = await this.ctx.ensureContext(config.browser.headless);
    const page = await context.newPage();

    try {
      await page.goto('https://creator.xiaohongshu.com/publish/publish', {
        waitUntil: 'domcontentloaded',
      });

      await page.waitForLoadState('networkidle').catch(() => {});
      await jitteredSleep(2000);

      // 点击"上传视频"标签
      const videoTab = await page.$(PUBLISH_SELECTORS.uploadVideoTab);
      if (videoTab) {
        await videoTab.click();
        await jitteredSleep(1000);
      }

      // 上传视频
      const uploadInput = await page.$(PUBLISH_SELECTORS.uploadInput);
      if (!uploadInput) {
        return { success: false, error: 'Upload input not found' };
      }

      await uploadInput.setInputFiles(params.videoPath);
      log.info('Uploading video', { path: params.videoPath });

      // 等待视频上传和处理（视频处理需要较长时间）
      await page.waitForSelector('.upload-success, .video-preview, .cover-container', {
        timeout: TIMEOUTS.VIDEO_UPLOAD,
      });
      await jitteredSleep(2000);

      // 如果提供了封面图，上传封面
      if (params.coverPath) {
        const coverInput = await page.$('.cover-upload input, [class*="cover"] input[type="file"]');
        if (coverInput) {
          await coverInput.setInputFiles(params.coverPath);
          await jitteredSleep(2000);
        }
      }

      // 填写标题（恢复"替换"语义 + 长度上限）
      const title = (params.title ?? '').slice(0, PUBLISH_TITLE_MAX);
      const titleInput = page.locator(PUBLISH_SELECTORS.titleInput).first();
      if ((await titleInput.count()) > 0) {
        await this.fillFieldLikeHuman(
          page,
          titleInput,
          title,
          { reviseEvery: 4, reviseMax: 1, maxDurationMs: 20000 },
          false,
        );
      }

      // 填写内容（恢复"替换"语义 + 长度上限）
      const content = (params.content ?? '').slice(0, PUBLISH_CONTENT_MAX);
      const contentEditor = page.locator(PUBLISH_SELECTORS.contentEditor).first();
      if ((await contentEditor.count()) > 0) {
        await this.fillFieldLikeHuman(
          page,
          contentEditor,
          content,
          { reviseEvery: 6, reviseMax: 1, maxDurationMs: 60000 },
          true,
        );
      }

      await jitteredSleep(1000);

      // 添加标签
      if (params.tags && params.tags.length > 0) {
        for (const tag of params.tags) {
          await typeLikeHuman(page, `#${tag}`);
          await jitteredSleep(500);
          const suggestion = await page.$(`${PUBLISH_SELECTORS.topicContainer}:has-text("${tag}")`);
          if (suggestion) {
            await suggestion.click();
          } else {
            await page.keyboard.press('Space');
          }
          await jitteredSleep(300);
        }
      }

      // 点击发布
      const publishBtn = await this.resolvePublishButton(page);
      if (!publishBtn) {
        return { success: false, error: 'A unique enabled publish button was not found' };
      }

      await publishBtn.click();
      await jitteredSleep(3000);

      return { success: true };
    } catch (error) {
      log.error('Video publish failed', { error: error instanceof Error ? error.message : String(error) });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await jitteredSleep(2000);
      await page.close();
    }
  }
}
