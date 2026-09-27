/**
 * Zhihuishu Bot - Popup 控制面板
 */
'use strict';

const cfg = globalThis.ZHSBotConfig;
const SETTINGS_KEY = cfg.SETTINGS_KEY;
const DEFAULT_SETTINGS = cfg.DEFAULT_SETTINGS;
const STATE_LABEL = cfg.STATE_LABEL;

const TOGGLE_IDS = ['autoPlay', 'autoNext', 'handleNotice', 'autoAnswerQuiz'];

const el = {
  toggles: {},
  strategy: document.getElementById('select-strategy'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  courseTitle: document.getElementById('course-title'),
  hint: document.getElementById('hint'),
  logs: document.getElementById('logs'),
  clearLogs: document.getElementById('btn-clear-logs')
};

TOGGLE_IDS.forEach((key) => {
  el.toggles[key] = document.getElementById('toggle-' + key);
});

let settings = Object.assign({}, DEFAULT_SETTINGS);
let pollTimer = null;

/* ------------------------------------------------------------------ */
/* 设置读写                                                            */
/* ------------------------------------------------------------------ */

function renderSettings() {
  TOGGLE_IDS.forEach((key) => {
    if (el.toggles[key]) el.toggles[key].checked = !!settings[key];
  });
  if (el.strategy) el.strategy.value = settings.quizAnswerStrategy || 'smart';
}

function saveSettings() {
  const payload = {
    autoPlay: !!settings.autoPlay,
    autoNext: !!settings.autoNext,
    handleNotice: !!settings.handleNotice,
    autoAnswerQuiz: !!settings.autoAnswerQuiz,
    quizAnswerStrategy: settings.quizAnswerStrategy || 'smart'
  };
  chrome.storage.local.set({ [SETTINGS_KEY]: payload }, () => {
    void chrome.runtime.lastError;
    // 通知当前标签页所有 frame 立即生效
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab) return;
      chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_CHANGED', settings: payload }, () => {
        void chrome.runtime.lastError;
      });
    });
    refresh();
  });
}

function loadSettings() {
  chrome.storage.local.get([SETTINGS_KEY], (res) => {
    void chrome.runtime.lastError;
    const saved = (res && res[SETTINGS_KEY]) || {};
    settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    renderSettings();
  });
}

TOGGLE_IDS.forEach((key) => {
  const input = el.toggles[key];
  if (!input) return;
  input.addEventListener('change', () => {
    settings[key] = input.checked;
    saveSettings();
  });
});

el.strategy.addEventListener('change', () => {
  settings.quizAnswerStrategy = el.strategy.value;
  saveSettings();
});

el.clearLogs.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_LOGS' }, () => {
      void chrome.runtime.lastError;
    });
  });
  el.logs.innerHTML = '<li class="empty">暂无日志</li>';
});

/* ------------------------------------------------------------------ */
/* 状态渲染                                                            */
/* ------------------------------------------------------------------ */

function renderStatus(agg) {
  const state = agg && agg.state ? agg.state : 'no_page';
  const label = STATE_LABEL[state] || state;

  el.statusDot.className = 'status-dot ' + state;
  el.statusText.textContent = label;

  el.courseTitle.textContent = (agg && agg.title) ? agg.title : '—';

  const hint = agg && agg.hint ? agg.hint : '';
  if (hint) {
    el.hint.textContent = hint;
    el.hint.classList.add('show');
  } else {
    el.hint.textContent = '';
    el.hint.classList.remove('show');
  }
}

function renderLogs(logs) {
  if (!logs || !logs.length) {
    el.logs.innerHTML = '<li class="empty">暂无日志</li>';
    return;
  }
  const recent = logs.slice(-60).reverse();
  const html = recent.map((entry) => {
    const level = entry.level || 'info';
    const time = escapeHtml(entry.time || '');
    const message = escapeHtml(entry.message || '');
    return '<li class="' + level + '"><span class="t">' + time + '</span><span class="m">' + message + '</span></li>';
  }).join('');
  el.logs.innerHTML = html;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ */
/* 轮询                                                                */
/* ------------------------------------------------------------------ */

function refresh() {
  chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB_STATE' }, (res) => {
    void chrome.runtime.lastError;
    if (!res || !res.ok) {
      renderStatus(null);
      return;
    }
    const agg = res.aggregated;
    if (!agg) {
      renderStatus({ state: 'no_page', title: res.title || '', hint: '' });
      renderLogs([]);
      return;
    }
    renderStatus(agg);
    renderLogs(agg.logs);
  });
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 1000);
}

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  refresh();
  startPolling();
});

window.addEventListener('unload', () => {
  if (pollTimer) clearInterval(pollTimer);
});
