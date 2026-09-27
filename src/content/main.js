/**
 * Zhihuishu Bot - 主控模块
 * 状态机 + 定时轮询 + MutationObserver 兜底 + 跨 frame 协作。
 *
 * 运行位置：所有 frame（manifest 中 all_frames: true）。
 *   - 含视频的 frame 负责「自动播放 / 自动下一集」
 *   - 含弹窗的 frame 负责「弹窗 / 弹题处理」
 *   - 顶层 frame 会把「弹题中」广播给其它 frame，让播放逻辑暂停点击
 */
(function () {
  'use strict';

  const cfg = globalThis.ZHSBotConfig;
  const T = cfg.TIMING;
  const STATE = cfg.STATE;
  const S = cfg.SELECTORS;
  const D = globalThis.ZHSBotDetector;
  const P = globalThis.ZHSBotPlayer;
  const H = globalThis.ZHSBotPopupHandler;
  const logger = globalThis.ZHSBotLogger;

  const IS_TOP = window.top === window;

  /** 当前设置（来自 chrome.storage.local） */
  let settings = Object.assign({}, cfg.DEFAULT_SETTINGS);

  /** 是否被外部（弹题 / 其它 frame）要求暂停自动点击 */
  let hold = false;
  let holdReason = '';

  /** 运行态 */
  const runtime = {
    state: STATE.NO_PAGE,
    title: '',
    busy: false,
    lastRunAt: 0,
    playAttempts: 0,
    playBlockedUntil: 0,
    endedSince: 0,
    started: false
  };

  /* ------------------------------------------------------------------ */
  /* 设置                                                                */
  /* ------------------------------------------------------------------ */

  function loadSettings() {
    try {
      chrome.storage.local.get([cfg.SETTINGS_KEY], (res) => {
        if (chrome.runtime.lastError) return;
        const saved = (res && res[cfg.SETTINGS_KEY]) || {};
        settings = Object.assign({}, cfg.DEFAULT_SETTINGS, saved);
        logger.info('设置已加载：' + JSON.stringify(settings));
        schedule(0);
      });
    } catch (e) {
      logger.warn('读取设置失败，使用默认值');
    }
  }

  function allDisabled() {
    return !settings.autoPlay && !settings.autoNext && !settings.handleNotice && !settings.autoAnswerQuiz;
  }

  /* ------------------------------------------------------------------ */
  /* 状态上报                                                            */
  /* ------------------------------------------------------------------ */

  function report(state, extra) {
    runtime.state = state;
    const payload = Object.assign({
      state: state,
      title: runtime.title,
      hold: hold,
      holdReason: holdReason,
      isTop: IS_TOP,
      url: location.href,
      logs: logger.getLogs(),
      at: Date.now()
    }, extra || {});

    try {
      chrome.runtime.sendMessage({ type: 'STATE_UPDATE', payload: payload }, () => {
        // 主动读取 lastError，避免控制台出现 "Unchecked runtime.lastError"
        void chrome.runtime.lastError;
      });
    } catch (e) { /* 扩展被重载时可能抛错，忽略 */ }
  }

  /* ------------------------------------------------------------------ */
  /* 主循环                                                              */
  /* ------------------------------------------------------------------ */

  let loopTimer = null;

  function schedule(delayMs) {
    if (loopTimer) clearTimeout(loopTimer);
    loopTimer = setTimeout(() => {
      loopTimer = null;
      runOnce().catch((e) => logger.error('主循环异常：' + (e && e.message)));
    }, Math.max(0, delayMs || 0));
  }

  async function runOnce() {
    if (runtime.busy) return;
    runtime.busy = true;
    runtime.lastRunAt = Date.now();

    try {
      const snap = D.detect();
      runtime.title = snap.title || runtime.title;

      // 课程页都不是，直接上报，什么都不做
      if (snap.state === STATE.NO_PAGE) {
        report(STATE.NO_PAGE);
        return;
      }

      if (allDisabled()) {
        report(STATE.DISABLED);
        return;
      }

      /* ---------- 1) 弹题优先：最高优先级，先处理它 ---------- */
      if (snap.quiz) {
        setHold(true, '检测到弹题');
        if (settings.autoAnswerQuiz) {
          const r = await H.answerQuiz(snap.quiz, settings);
          if (r === 'blocked') {
            report(STATE.QUIZ, { hint: '检测到弹题，请完成后继续。' });
            return;
          }
          if (r === 'no-strategy') {
            report(STATE.QUIZ, { hint: '弹题选择器可能失效，请手动完成后继续。' });
            return;
          }
          // answered：窗口已关，下一轮会自然恢复
          report(STATE.QUIZ, { hint: '弹题已自动作答。' });
          schedule(500);
          return;
        }
        // 未开启自动作答：保持弹窗，提示用户
        logger.info('检测到弹题，请完成后继续。');
        report(STATE.QUIZ, { hint: '检测到弹题，请完成后继续。' });
        return;
      }

      // 弹题已消失 -> 解除 hold
      if (hold && holdReason === '检测到弹题') {
        H.resetQuizState();
        setHold(false, '');
      }

      /* ---------- 2) 普通弹窗 ---------- */
      if (settings.handleNotice) {
        H.handleNotices();
      }

      /* ---------- 3) 视频状态机 ---------- */
      if (snap.state === STATE.NO_VIDEO) {
        report(STATE.NO_VIDEO);
        return;
      }

      const video = snap.video;
      if (!video) {
        report(STATE.NO_VIDEO);
        return;
      }

      if (hold) {
        // 被其它 frame 要求暂停（例如顶层出现弹题）
        report(snap.state, { hint: holdReason });
        return;
      }

      if (snap.state === STATE.ENDED) {
        runtime.playAttempts = 0;
        if (!runtime.endedSince) runtime.endedSince = Date.now();

        // 持续「已结束」一段时间才动作，避免拖动进度条误判
        if (Date.now() - runtime.endedSince < T.endedConfirmMs) {
          report(STATE.ENDED);
          return;
        }

        if (!settings.autoNext) {
          report(STATE.ENDED, { hint: '自动下一集已关闭。' });
          return;
        }

        logger.info('视频播放结束，准备进入下一集');
        report(STATE.WAITING_NEXT);
        const ok = P.clickNext();
        if (!ok) {
          runtime.endedSince = 0;
          report(STATE.ENDED, { hint: '未找到「下一节」按钮，稍后重试。' });
          return;
        }

        const newVideo = await P.waitForNewVideo(video, T.nextVideoWaitMs);
        runtime.endedSince = 0;
        if (newVideo && settings.autoPlay) {
          const played = await P.tryPlay(newVideo);
          logger.log(played ? '下一集已开始播放' : '下一集已切换，等待自动播放重试', played ? 'success' : 'warn');
        }
        report(STATE.WAITING_NEXT);
        return;
      }

      runtime.endedSince = 0;

      if (snap.state === STATE.PAUSED) {
        if (!settings.autoPlay) {
          report(STATE.PAUSED, { hint: '自动播放已关闭。' });
          return;
        }

        if (Date.now() < runtime.playBlockedUntil) {
          report(STATE.PAUSED, { hint: '连续播放失败，退避中…' });
          return;
        }

        if (runtime.playAttempts >= T.maxPlayAttempts) {
          runtime.playAttempts = 0;
          runtime.playBlockedUntil = Date.now() + T.playBackoffMs;
          logger.warn('多次自动播放失败，退避 ' + Math.round(T.playBackoffMs / 1000) + ' 秒后重试');
          report(STATE.PAUSED, { hint: '多次播放失败，稍后重试。' });
          return;
        }

        runtime.playAttempts++;
        logger.info('视频处于暂停状态，尝试自动播放（第 ' + runtime.playAttempts + ' 次）');
        const played = await P.tryPlay(video);
        if (played) {
          runtime.playAttempts = 0;
          logger.success('视频已开始播放');
          report(STATE.PLAYING);
        } else {
          report(STATE.PAUSED, { hint: '自动播放未生效，稍后重试。' });
        }
        return;
      }

      // 正常播放中
      runtime.playAttempts = 0;
      report(STATE.PLAYING);
    } finally {
      runtime.busy = false;
      // 排下一轮
      schedule(T.pollIntervalMs);
    }
  }

  function setHold(value, reason) {
    if (hold === value && holdReason === reason) return;
    hold = value;
    holdReason = reason || '';
    if (value) {
      logger.warn('已暂停自动操作：' + (reason || ''));
      // 通知同标签页其它 frame 一起暂停
      try {
        chrome.runtime.sendMessage({ type: 'HOLD_BROADCAST', value: true, reason: reason }, () => {
          void chrome.runtime.lastError;
        });
      } catch (e) { /* ignore */ }
    } else {
      logger.info('已恢复自动操作');
      try {
        chrome.runtime.sendMessage({ type: 'HOLD_BROADCAST', value: false, reason: '' }, () => {
          void chrome.runtime.lastError;
        });
      } catch (e) { /* ignore */ }
    }
  }

  /* ------------------------------------------------------------------ */
  /* MutationObserver（立即响应 DOM 变化，轮询作为兜底）                  */
  /* ------------------------------------------------------------------ */

  let moTimer = null;
  function startObserver() {
    try {
      const observer = new MutationObserver(() => {
        // 防抖：DOM 频繁变化时不要每帧都跑
        if (moTimer) return;
        moTimer = setTimeout(() => {
          moTimer = null;
          schedule(300);
        }, 300);
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });
      logger.info('MutationObserver 已启动');
    } catch (e) {
      logger.warn('MutationObserver 启动失败，仅使用定时轮询');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 与 popup / background 通信                                          */
  /* ------------------------------------------------------------------ */

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case 'GET_STATE':
          sendResponse({
            state: runtime.state,
            title: runtime.title,
            hold: hold,
            holdReason: holdReason,
            isTop: IS_TOP,
            url: location.href,
            settings: settings,
            logs: logger.getLogs(),
            quiz: H.getQuizState()
          });
          break;

        case 'SETTINGS_CHANGED':
          settings = Object.assign({}, cfg.DEFAULT_SETTINGS, msg.settings || {});
          logger.info('设置已更新：' + JSON.stringify(settings));
          runtime.playBlockedUntil = 0;
          runtime.playAttempts = 0;
          schedule(0);
          sendResponse({ ok: true });
          break;

        case 'HOLD':
          hold = !!msg.value;
          holdReason = msg.reason || '';
          schedule(0);
          sendResponse({ ok: true });
          break;

        case 'CLEAR_LOGS':
          logger.clear();
          sendResponse({ ok: true });
          break;

        case 'PING':
          sendResponse({ ok: true, isTop: IS_TOP });
          break;

        default:
          break;
      }
      return true;
    });
  } catch (e) {
    logger.error('消息监听注册失败：' + (e && e.message));
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  function boot() {
    if (runtime.started) return;
    runtime.started = true;
    logger.info('Zhihuishu Bot 已注入（' + (IS_TOP ? '顶层页面' : '子 frame') + '）');
    startObserver();
    loadSettings();
    schedule(1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
