/**
 * Zhihuishu Bot - 播放控制
 * 负责自动播放、自动下一集。所有点击都带冷却与重试上限，
 * 避免网络卡顿时疯狂点击；任何异常都只记日志不抛出。
 */
(function () {
  'use strict';

  const cfg = globalThis.ZHSBotConfig;
  const T = cfg.TIMING;
  const D = globalThis.ZHSBotDetector;
  const logger = globalThis.ZHSBotLogger;

  /** 最近一次点击时间，用于全局冷却 */
  const lastClickAt = new Map();

  function canClick(el, cooldown) {
    const last = lastClickAt.get(el) || 0;
    return Date.now() - last >= (cooldown || T.clickCooldownMs);
  }

  /** 安全点击：可见性 + 红线 + 冷却 三重校验 */
  function safeClick(el, reason) {
    if (!el) return false;
    if (!D.isVisible(el)) return false;
    if (D.isForbidden(el)) {
      logger.warn('跳过危险按钮（命中禁用词）：' + D.textOf(el).slice(0, 20));
      return false;
    }
    if (!canClick(el)) return false;

    try {
      el.scrollIntoView({ block: 'center', behavior: 'auto' });
    } catch (e) { /* ignore */ }

    try {
      el.click();
      lastClickAt.set(el, Date.now());
      logger.info('已点击：' + (reason || D.textOf(el).slice(0, 20) || el.tagName));
      return true;
    } catch (e) {
      logger.error('点击失败：' + (e && e.message));
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 自动播放                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 尝试让视频开始播放。
   * 优先调用 video.play()，被浏览器策略拒绝时再退回点击播放按钮。
   * @returns {Promise<boolean>}
   */
  async function tryPlay(video) {
    if (!video) return false;

    try {
      const p = video.play();
      if (p && typeof p.then === 'function') {
        await p;
      }
      return !video.paused;
    } catch (e) {
      // 自动播放被拦截，或播放器需要用户手势，退回点击播放按钮
      logger.warn('video.play() 被拒绝（' + (e && e.name) + '），改用点击播放按钮');
    }

    const btn = D.getPlayButton();
    if (btn && safeClick(btn, '播放按钮')) {
      await sleep(600);
      return !video.paused;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* 下一集                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * 点击「下一节 / 下一集」。
   * @returns {boolean} 是否成功触发点击
   */
  function clickNext() {
    const btn = D.getNextButton();
    if (!btn) {
      logger.warn('未找到「下一节」按钮，将在下一轮继续检测');
      return false;
    }
    return safeClick(btn, '下一节');
  }

  /**
   * 等待新视频加载完成（currentTime 归零 或 src 变化 或 出现新的 video 元素）
   * @param {HTMLVideoElement|null} oldVideo
   * @param {number} timeoutMs
   * @returns {Promise<HTMLVideoElement|null>}
   */
  function waitForNewVideo(oldVideo, timeoutMs) {
    const limit = timeoutMs || T.nextVideoWaitMs;
    const oldSrc = oldVideo ? oldVideo.currentSrc || oldVideo.src : '';
    const startedAt = Date.now();

    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const v = D.getVideo();
        const changed = v && (
          v !== oldVideo ||
          (v.currentSrc || v.src) !== oldSrc ||
          v.currentTime < 3
        );
        if (changed && v) {
          clearInterval(timer);
          resolve(v);
          return;
        }
        if (Date.now() - startedAt > limit) {
          clearInterval(timer);
          logger.warn('等待下一集加载超时，继续下一轮检测');
          resolve(D.getVideo());
        }
      }, 500);
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  globalThis.ZHSBotPlayer = {
    safeClick,
    tryPlay,
    clickNext,
    waitForNewVideo,
    sleep
  };
})();
