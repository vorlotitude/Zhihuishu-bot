/**
 * Zhihuishu Bot - Background Service Worker (MV3)
 *
 * 职责：
 *  1. 汇总同一标签页内所有 frame 上报的状态（视频可能在 iframe 里，弹窗在顶层）
 *  2. 把「弹题中」这类暂停信号广播给该标签页的其它 frame
 *  3. 为 popup 提供当前标签页的聚合状态
 *  4. 维护扩展图标上的状态徽标
 *
 * 这里不保存任何账号、Cookie、Token 等隐私信息。
 */
'use strict';

// 复用 content script 的同一份配置，保证选择器与默认设置只有一个来源
importScripts('/src/config/selectors.js');

const cfg = globalThis.ZHSBotConfig;
const SETTINGS_KEY = (cfg && cfg.SETTINGS_KEY) || 'zhs_bot_settings';
const DEFAULT_SETTINGS = (cfg && cfg.DEFAULT_SETTINGS) || {
  autoPlay: true,
  autoNext: true,
  handleNotice: true,
  autoAnswerQuiz: true,
  quizAnswerStrategy: 'smart'
};

/** tabId -> { frames: Map<frameId, payload>, updatedAt } */
const tabStates = new Map();

/** 状态优先级：数值越大越「值得展示」 */
const STATE_PRIORITY = {
  quiz: 90,
  waiting_next: 80,
  ended: 70,
  paused: 60,
  playing: 50,
  no_video: 40,
  no_page: 30,
  disabled: 20
};

const BADGE = {
  quiz: { text: '题', color: '#e6a23c' },
  waiting_next: { text: '次', color: '#409eff' },
  ended: { text: '完', color: '#409eff' },
  paused: { text: '||', color: '#909399' },
  playing: { text: '▶', color: '#67c23a' },
  no_video: { text: '-', color: '#c0c4cc' },
  no_page: { text: '', color: '#c0c4cc' },
  disabled: { text: 'off', color: '#c0c4cc' }
};

/* ------------------------------------------------------------------ */
/* 聚合                                                                */
/* ------------------------------------------------------------------ */

function aggregate(tabId) {
  const entry = tabStates.get(tabId);
  if (!entry || !entry.frames.size) return null;

  let best = null;
  let bestScore = -1;
  let bestLogs = [];
  let title = '';

  entry.frames.forEach((p) => {
    if (!p) return;
    const score = STATE_PRIORITY[p.state] || 0;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
    if (p.logs && p.logs.length > bestLogs.length) bestLogs = p.logs;
    if (!title && p.title) title = p.title;
  });

  if (!best) return null;
  return Object.assign({}, best, { title: title || best.title || '', logs: bestLogs });
}

function updateBadge(tabId, state) {
  const b = BADGE[state];
  try {
    if (!b || !b.text) {
      chrome.action.setBadgeText({ tabId: tabId, text: '' });
      return;
    }
    chrome.action.setBadgeText({ tabId: tabId, text: b.text });
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: b.color });
  } catch (e) { /* 标签页可能已关闭 */ }
}

/* ------------------------------------------------------------------ */
/* 消息处理                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  const frameId = sender && typeof sender.frameId === 'number' ? sender.frameId : 0;

  switch (msg.type) {
    case 'STATE_UPDATE': {
      if (typeof tabId !== 'number') break;
      let entry = tabStates.get(tabId);
      if (!entry) {
        entry = { frames: new Map(), updatedAt: 0 };
        tabStates.set(tabId, entry);
      }
      entry.frames.set(frameId, msg.payload);
      entry.updatedAt = Date.now();

      const agg = aggregate(tabId);
      if (agg) updateBadge(tabId, agg.state);
      break;
    }

    case 'HOLD_BROADCAST': {
      // 某个 frame 进入/退出「暂停自动操作」，广播给同标签页其它 frame
      if (typeof tabId !== 'number') break;
      chrome.tabs.sendMessage(tabId, { type: 'HOLD', value: !!msg.value, reason: msg.reason || '' }, () => {
        void chrome.runtime.lastError;
      });
      break;
    }

    case 'GET_ACTIVE_TAB_STATE': {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) {
          sendResponse({ ok: false, reason: 'no_active_tab' });
          return;
        }
        const agg = aggregate(tab.id);
        sendResponse({
          ok: true,
          tabId: tab.id,
          url: tab.url || '',
          title: tab.title || '',
          aggregated: agg
        });
      });
      return true; // 异步响应
    }

    case 'GET_TAB_STATE': {
      const agg = aggregate(msg.tabId);
      sendResponse({ ok: true, aggregated: agg });
      break;
    }

    case 'OPEN_OPTIONS_HINT': {
      sendResponse({ ok: true });
      break;
    }

    default:
      break;
  }
  return true;
});

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.get([SETTINGS_KEY], (res) => {
    if (chrome.runtime.lastError) return;
    if (!res || !res[SETTINGS_KEY]) {
      chrome.storage.local.set({ [SETTINGS_KEY]: Object.assign({}, DEFAULT_SETTINGS) });
    }
  });
  if (details && details.reason === 'install') {
    chrome.action.setBadgeText({ text: '' });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // 页面刷新/跳转时清掉旧状态，避免展示上一页的残留信息
  if (changeInfo && changeInfo.status === 'loading') {
    tabStates.delete(tabId);
    updateBadge(tabId, 'no_page');
  }
});
