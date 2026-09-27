/**
 * Zhihuishu Bot - 元素检测层
 * 负责在「多组候选选择器」中找出真正可用的元素，并提供页面状态判断。
 * 所有 DOM 查询都带异常捕获，页面结构变化时只会记录日志、不会中断运行。
 */
(function () {
  'use strict';

  const cfg = globalThis.ZHSBotConfig;
  const S = cfg.SELECTORS;
  const STATE = cfg.STATE;
  const logger = globalThis.ZHSBotLogger;

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                            */
  /* ------------------------------------------------------------------ */

  function queryOne(selector, root) {
    try {
      return (root || document).querySelector(selector);
    } catch (e) {
      logger.warn('选择器语法错误，已跳过：' + selector);
      return null;
    }
  }

  function queryAll(selector, root) {
    try {
      return Array.prototype.slice.call((root || document).querySelectorAll(selector));
    } catch (e) {
      logger.warn('选择器语法错误，已跳过：' + selector);
      return [];
    }
  }

  /** 元素是否真实可见（排除 display:none / 尺寸为 0 / 完全透明） */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    let style;
    try {
      style = window.getComputedStyle(el);
    } catch (e) {
      return false;
    }
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (parseFloat(style.opacity || '1') < 0.05) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    return true;
  }

  /** 在候选选择器列表里返回第一个可见元素 */
  function firstVisible(selectors, root) {
    for (let i = 0; i < selectors.length; i++) {
      const found = queryAll(selectors[i], root).filter(isVisible);
      if (found.length) return found[0];
    }
    return null;
  }

  /** 在候选选择器列表里返回全部可见元素（去重） */
  function allVisible(selectors, root) {
    const out = [];
    const seen = new Set();
    for (let i = 0; i < selectors.length; i++) {
      queryAll(selectors[i], root).forEach((el) => {
        if (isVisible(el) && !seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      });
    }
    return out;
  }

  function textOf(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** 元素是否可点击（button / a / 有 role 或 cursor:pointer） */
  function isClickable(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT') return true;
    if (el.getAttribute && (el.getAttribute('role') === 'button' || el.hasAttribute('onclick'))) return true;
    try {
      const cursor = window.getComputedStyle(el).cursor;
      if (cursor === 'pointer') return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  /**
   * 按文字内容查找元素（选择器失效时的兜底手段）
   * @param {string[]} texts 目标文字
   * @param {object} [opts] { root, exact, clickableOnly, maxTextLen }
   */
  function findByText(texts, opts) {
    const o = opts || {};
    const root = o.root || document;
    const exact = !!o.exact;
    const clickableOnly = o.clickableOnly !== false;
    const maxTextLen = o.maxTextLen || 30;

    let nodes;
    try {
      nodes = Array.prototype.slice.call(
        root.querySelectorAll('button, a, div, span, li, p, input[type="button"], input[type="submit"]')
      );
    } catch (e) {
      return null;
    }

    let best = null;
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!isVisible(el)) continue;
      const t = textOf(el);
      if (!t || t.length > maxTextLen) continue;

      let hit = false;
      for (let j = 0; j < texts.length; j++) {
        const target = texts[j];
        if (exact ? t === target : t.indexOf(target) !== -1) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
      if (clickableOnly && !isClickable(el)) continue;

      // 优先选最内层（文字最少的）那个，避免点到包裹层
      if (!best || t.length < textOf(best).length) best = el;
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* 安全红线                                                            */
  /* ------------------------------------------------------------------ */

  /** 元素（或其自身文字）是否命中危险词 */
  function isForbidden(el) {
    const t = textOf(el);
    if (!t) return false;
    return S.forbiddenTexts.some((w) => t.indexOf(w) !== -1);
  }

  /**
   * 判断某个弹窗内是否出现「正式考试」相关字样。
   * 命中则禁止自动作答，只提示用户。
   */
  function isExamLike(el) {
    const t = textOf(el);
    if (!t) return false;
    return S.quizExamKeywords.some((w) => t.indexOf(w) !== -1);
  }

  /* ------------------------------------------------------------------ */
  /* 页面 / 视频                                                         */
  /* ------------------------------------------------------------------ */

  function isCoursePage() {
    const href = location.href.toLowerCase();
    const hostOk = !S.hosts.length || S.hosts.some((h) => location.hostname.indexOf(h) !== -1);
    if (!hostOk) return false;
    // 命中 URL 特征，或者页面上确实存在 video 元素
    const urlOk = S.urlHints.some((h) => href.indexOf(h) !== -1);
    return urlOk || !!getVideo();
  }

  function getVideo() {
    const candidates = allVisible(S.video);
    if (candidates.length) {
      // 多个 video 时，取尺寸最大的那个（通常是主播放器）
      return candidates.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      })[0];
    }
    // 隐藏的 video（部分实现播放器尺寸为 0）也要兜底找到
    for (let i = 0; i < S.video.length; i++) {
      const el = queryOne(S.video[i]);
      if (el && el.tagName === 'VIDEO') return el;
    }
    return null;
  }

  function getVideoContainer() {
    return firstVisible(S.videoContainer);
  }

  function getCourseTitle() {
    const el = firstVisible(S.courseTitle);
    if (el) {
      const t = textOf(el);
      if (t && t.length < 120) return t;
    }
    // 兜底：从 document.title 里取
    return (document.title || '').replace(/[-_|].*$/, '').trim();
  }

  function getCatalogRoot() {
    return firstVisible(S.catalog);
  }

  function getCurrentCatalogItem() {
    return firstVisible(S.catalogCurrent);
  }

  /* ------------------------------------------------------------------ */
  /* 按钮                                                                */
  /* ------------------------------------------------------------------ */

  function getPlayButton() {
    const el = firstVisible(S.playButton);
    if (el && !isForbidden(el)) return el;
    return null;
  }

  function getNextButton() {
    // 1) 先按选择器找
    const bySelector = firstVisible(S.nextButton);
    if (bySelector && !isForbidden(bySelector)) return bySelector;

    // 2) 再按文字找，并把范围限制在目录/播放区域内
    const scopes = [getCatalogRoot(), getVideoContainer(), document].filter(Boolean);
    for (let i = 0; i < scopes.length; i++) {
      const el = findByText(S.nextButtonTexts, { root: scopes[i], maxTextLen: 12 });
      if (el && !isForbidden(el)) return el;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* 弹窗                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 找「弹题测验」窗口。
   * 双重判定：结构命中 quizDialog 选择器 **且** 内容命中 quizKeywords。
   */
  function getQuizDialog() {
    const dialogs = allVisible(S.quizDialog);
    for (let i = 0; i < dialogs.length; i++) {
      const d = dialogs[i];
      const t = textOf(d);
      if (!t) continue;
      if (S.quizKeywords.some((k) => t.indexOf(k) !== -1)) return d;
    }
    return null;
  }

  /** 找普通提示 / 公告弹窗（排除弹题窗口） */
  function getNoticeDialogs() {
    const quiz = getQuizDialog();
    return allVisible(S.noticeDialog).filter((d) => {
      if (quiz && (d === quiz || d.contains(quiz) || quiz.contains(d))) return false;
      return true;
    });
  }

  function getQuizOptions(dialog) {
    if (!dialog) return [];
    const bySelector = allVisible(S.quizOption, dialog);
    if (bySelector.length) return bySelector;

    // 兜底：在弹窗里找所有 input
    const inputs = [];
    S.quizOptionInput.forEach((sel) => {
      queryAll(sel, dialog).forEach((el) => {
        const label = el.closest('label') || el.parentElement;
        if (label && isVisible(label)) inputs.push(label);
        else if (isVisible(el)) inputs.push(el);
      });
    });
    return inputs;
  }

  function getQuizNextButton(dialog) {
    if (!dialog) return null;
    const bySelector = firstVisible(S.quizNextButton, dialog);
    if (bySelector && !isForbidden(bySelector)) return bySelector;
    const byText = findByText(S.quizNextTexts, { root: dialog, maxTextLen: 8 });
    if (byText && !isForbidden(byText)) return byText;
    return null;
  }

  function getQuizSubmitButton(dialog) {
    if (!dialog) return null;
    const byText = findByText(S.quizSubmitTexts, { root: dialog, maxTextLen: 8 });
    if (byText && !isForbidden(byText)) return byText;
    const bySelector = firstVisible(S.quizSubmitButton, dialog);
    if (bySelector && !isForbidden(bySelector)) return bySelector;
    return null;
  }

  function getQuizCloseButton(dialog) {
    if (!dialog) return null;
    return firstVisible(S.quizCloseButton, dialog);
  }

  /* ------------------------------------------------------------------ */
  /* 状态判定                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * @returns {{state:string, video:HTMLVideoElement|null, quiz:Element|null, title:string}}
   */
  function detect() {
    const quiz = getQuizDialog();
    const video = getVideo();
    const title = getCourseTitle();

    if (!isCoursePage()) {
      return { state: STATE.NO_PAGE, video: video, quiz: quiz, title: title };
    }
    if (quiz) {
      return { state: STATE.QUIZ, video: video, quiz: quiz, title: title };
    }
    if (!video) {
      return { state: STATE.NO_VIDEO, video: null, quiz: null, title: title };
    }

    const duration = video.duration;
    const current = video.currentTime;
    const tolerance = cfg.TIMING.endedToleranceSec;

    let state;
    if (video.ended || (isFinite(duration) && duration > 0 && duration - current <= tolerance)) {
      state = STATE.ENDED;
    } else if (video.paused) {
      state = STATE.PAUSED;
    } else {
      state = STATE.PLAYING;
    }
    return { state: state, video: video, quiz: null, title: title };
  }

  globalThis.ZHSBotDetector = {
    queryOne,
    queryAll,
    isVisible,
    firstVisible,
    allVisible,
    textOf,
    isClickable,
    findByText,
    isForbidden,
    isExamLike,
    isCoursePage,
    getVideo,
    getVideoContainer,
    getCourseTitle,
    getCatalogRoot,
    getCurrentCatalogItem,
    getPlayButton,
    getNextButton,
    getQuizDialog,
    getNoticeDialogs,
    getQuizOptions,
    getQuizNextButton,
    getQuizSubmitButton,
    getQuizCloseButton,
    detect
  };
})();
