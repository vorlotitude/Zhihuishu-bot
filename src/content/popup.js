/**
 * Zhihuishu Bot - 弹窗处理
 * 1) 普通提示 / 公告弹窗：自动关闭（白名单文字，绝不点危险按钮）
 * 2) 弹题测验：按策略自动作答并提交，让课程继续播放
 *
 * 安全边界（硬编码，不提供开关）：
 *   - 弹窗内出现「考试 / 试卷 / 期末 / 期中 / 补考 / 成绩」等字样 -> 立即停止自动作答
 *   - 命中 selectors.js 中 forbiddenTexts 的按钮 -> 永不点击
 */
(function () {
  'use strict';

  const cfg = globalThis.ZHSBotConfig;
  const S = cfg.SELECTORS;
  const T = cfg.TIMING;
  const D = globalThis.ZHSBotDetector;
  const P = globalThis.ZHSBotPlayer;
  const logger = globalThis.ZHSBotLogger;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------ */
  /* 普通弹窗                                                            */
  /* ------------------------------------------------------------------ */

  const noticeClickedAt = new WeakMap();

  /** 该弹窗是否安全可关（不是弹题、不是考试、不是危险确认框） */
  function isSafeToClose(dialog) {
    const t = D.textOf(dialog);
    if (!t) return false;
    if (S.quizKeywords.some((k) => t.indexOf(k) !== -1)) return false;
    if (D.isExamLike(dialog)) return false;
    if (S.forbiddenTexts.some((w) => t.indexOf(w) !== -1)) return false;
    return true;
  }

  /** 在弹窗内找「可安全点击」的关闭按钮 */
  function findSafeCloseButton(dialog) {
    // 1) 结构选择器
    const bySelector = D.firstVisible(S.noticeCloseButton, dialog);
    if (bySelector && !D.isForbidden(bySelector) && D.isVisible(bySelector)) return bySelector;

    // 2) 文字白名单
    const byText = D.findByText(S.noticeCloseTexts, { root: dialog, maxTextLen: 12, exact: false });
    if (byText && !D.isForbidden(byText)) return byText;

    return null;
  }

  /**
   * 处理普通提示 / 公告弹窗
   * @returns {number} 本次关闭的弹窗数量
   */
  function handleNotices() {
    let closed = 0;

    // (a) 顶部提示条：文字为「不再提示」，语义唯一，可安全点击
    const banner = D.findByText(['不再提示'], { root: document, maxTextLen: 8, exact: true });
    if (banner && !D.isForbidden(banner) && canClickOnce(banner, 60000)) {
      if (P.safeClick(banner, '关闭顶部提示条')) closed++;
    }

    // (b) 弹窗类
    const dialogs = D.getNoticeDialogs();
    for (let i = 0; i < dialogs.length; i++) {
      const dialog = dialogs[i];
      if (!isSafeToClose(dialog)) continue;
      const btn = findSafeCloseButton(dialog);
      if (!btn) continue;
      if (!canClickOnce(dialog, 30000)) continue;
      if (P.safeClick(btn, '关闭普通弹窗')) closed++;
    }

    if (closed) logger.info('已关闭 ' + closed + ' 个普通弹窗');
    return closed;
  }

  function canClickOnce(el, intervalMs) {
    const last = noticeClickedAt.get(el) || 0;
    if (Date.now() - last < intervalMs) return false;
    noticeClickedAt.set(el, Date.now());
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* 弹题测验                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 弹题状态机。因为弹题是一个「多题轮播」窗口，
   * 这里用循环把每一题都处理掉，直到窗口关闭或达到重试上限。
   */
  const quizState = {
    dialog: null,
    rounds: 0,
    lastRunAt: 0,
    /** 'idle' | 'running' | 'answered' | 'blocked' | 'no-strategy' */
    result: 'idle'
  };

  /** 弹题窗口消失后重置状态，便于下一题重新作答 */
  function resetQuizState() {
    quizState.dialog = null;
    quizState.rounds = 0;
    quizState.result = 'idle';
  }

  /**
   * 按策略挑出要选的选项
   * @param {Element[]} options
   * @param {string} strategy smart | first | all | random
   * @param {Element} dialog
   */
  function pickOptions(options, strategy, dialog) {
    if (!options.length) return [];
    const text = D.textOf(dialog);

    switch (strategy) {
      case 'all':
        return options.slice();
      case 'random':
        return [options[Math.floor(Math.random() * options.length)]];
      case 'smart':
        // 多选题 -> 全选；单选/判断/填空 -> 选第一个
        if (text.indexOf('多选') !== -1) return options.slice();
        return [options[0]];
      case 'first':
      default:
        return [options[0]];
    }
  }

  /** 点选一个选项（兼容「点 label」和「点内部 input」两种实现） */
  function selectOption(el) {
    if (!el) return false;
    if (D.isForbidden(el)) return false;
    try {
      const input = el.querySelector && el.querySelector('input[type="radio"], input[type="checkbox"]');
      if (input && !input.checked) {
        input.click();
        return true;
      }
      el.click();
      return true;
    } catch (e) {
      logger.warn('点选选项失败：' + (e && e.message));
      return false;
    }
  }

  /**
   * 自动作答弹题
   * @param {Element} dialog 弹题窗口
   * @param {object} settings
   * @returns {Promise<string>} 'answered' | 'blocked' | 'no-strategy' | 'gone'
   */
  async function answerQuiz(dialog, settings) {
    if (!dialog) return 'gone';

    // ---- 红线 1：考试类弹窗，一律不动 ----
    if (D.isExamLike(dialog)) {
      logger.warn('弹窗疑似正式考试，已停止自动作答，请手动处理');
      quizState.result = 'blocked';
      return 'blocked';
    }

    // ---- 红线 2：功能未开启 ----
    if (!settings || !settings.autoAnswerQuiz) {
      quizState.result = 'blocked';
      return 'blocked';
    }

    const strategy = settings.quizAnswerStrategy || 'smart';

    // 同一窗口短时间内不重复跑，防止主循环反复触发
    if (quizState.dialog === dialog && quizState.result === 'answered' && Date.now() - quizState.lastRunAt < 8000) {
      return 'answered';
    }
    if (quizState.dialog === dialog && quizState.rounds >= T.quizMaxRounds) {
      return quizState.result;
    }
    if (quizState.dialog !== dialog) {
      quizState.dialog = dialog;
      quizState.rounds = 0;
    }

    logger.info('检测到弹题，开始自动作答（策略：' + strategy + '）');

    for (let round = 0; round < T.quizMaxRounds; round++) {
      quizState.rounds = round + 1;
      quizState.lastRunAt = Date.now();

      if (!dialog.isConnected || !D.isVisible(dialog)) {
        logger.success('弹题窗口已关闭，恢复自动播放');
        quizState.result = 'answered';
        return 'answered';
      }
      if (D.isExamLike(dialog)) {
        logger.warn('弹窗内容变化为考试类，已停止自动作答');
        quizState.result = 'blocked';
        return 'blocked';
      }

      // 1) 选答案
      const options = D.getQuizOptions(dialog);
      if (!options.length) {
        logger.warn('未找到弹题选项，可能选择器需要更新（见 src/config/selectors.js 的 quizOption）');
        quizState.result = 'no-strategy';
        break;
      }

      const picked = pickOptions(options, strategy, dialog);
      for (let i = 0; i < picked.length; i++) {
        selectOption(picked[i]);
        await sleep(T.quizStepDelayMs);
      }
      logger.info('第 ' + (round + 1) + ' 题：已选择 ' + picked.length + ' 个选项');

      // 2) 下一题 / 提交
      const nextBtn = D.getQuizNextButton(dialog);
      if (nextBtn) {
        P.safeClick(nextBtn, '弹题-下一题');
        await sleep(T.quizNextDelayMs);
        continue;
      }

      const submitBtn = D.getQuizSubmitButton(dialog);
      if (submitBtn) {
        P.safeClick(submitBtn, '弹题-提交');
        await sleep(T.quizSubmitDelayMs);
        if (!dialog.isConnected || !D.isVisible(dialog)) {
          logger.success('弹题已提交并关闭，恢复自动播放');
          quizState.result = 'answered';
          return 'answered';
        }
        continue;
      }

      // 3) 没有下一题也没有提交：直接关闭弹窗（弹题不计成绩，平台自带「关闭」按钮）
      const closeBtn = D.getQuizCloseButton(dialog);
      if (closeBtn) {
        P.safeClick(closeBtn, '弹题-关闭');
        await sleep(T.quizSubmitDelayMs);
        if (!dialog.isConnected || !D.isVisible(dialog)) {
          logger.success('弹题窗口已关闭，恢复自动播放');
          quizState.result = 'answered';
          return 'answered';
        }
        continue;
      }

      logger.warn('弹题窗口内未找到「下一题/提交/关闭」按钮，停止作答并等待人工处理');
      quizState.result = 'no-strategy';
      break;
    }

    if (quizState.result === 'idle') quizState.result = 'no-strategy';
    return quizState.result;
  }

  globalThis.ZHSBotPopupHandler = {
    handleNotices,
    answerQuiz,
    resetQuizState,
    getQuizState: () => ({ result: quizState.result, rounds: quizState.rounds })
  };
})();
