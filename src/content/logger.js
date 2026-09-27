/**
 * Zhihuishu Bot - 日志系统
 * 环形缓冲区 + 控制台输出，日志会随状态一起上报给 popup。
 */
(function () {
  'use strict';

  const cfg = globalThis.ZHSBotConfig;
  const MAX = (cfg && cfg.TIMING && cfg.TIMING.maxLogEntries) || 200;
  const TO_CONSOLE = !!(cfg && cfg.TIMING && cfg.TIMING.debugToConsole);

  /** @type {{time:string, level:string, message:string}[]} */
  const buffer = [];
  let seq = 0;

  function pad(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function nowText() {
    const d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /**
   * 写一条日志
   * @param {string} message 日志内容
   * @param {'info'|'warn'|'error'|'success'} [level]
   */
  function log(message, level) {
    const entry = {
      id: ++seq,
      time: nowText(),
      level: level || 'info',
      message: String(message)
    };
    buffer.push(entry);
    while (buffer.length > MAX) buffer.shift();

    if (TO_CONSOLE) {
      const prefix = '[Zhihuishu Bot]';
      if (level === 'error') console.error(prefix, entry.time, message);
      else if (level === 'warn') console.warn(prefix, entry.time, message);
      else console.log(prefix, entry.time, message);
    }
    return entry;
  }

  const info = (m) => log(m, 'info');
  const warn = (m) => log(m, 'warn');
  const error = (m) => log(m, 'error');
  const success = (m) => log(m, 'success');

  function getLogs() {
    return buffer.slice();
  }

  function clear() {
    buffer.length = 0;
  }

  globalThis.ZHSBotLogger = { log, info, warn, error, success, getLogs, clear };
})();
