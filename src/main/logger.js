'use strict';
/**
 * QCL 电脑版 · 启动日志（内存缓冲 + 事件转发 + 读取）
 *
 * ★ 分工（避免重复行）：**落盘由启动核心负责**（`core/install.js`、`core/launch.js` 各自
 *   覆盖式写 `<QCL_HOME>/logs/latest.log`，UTF-8 无 BOM）。
 *   本模块**不写文件**，只做三件事：
 *     1. 在内存里保留尾部若干行；
 *     2. 把每一行转发给界面（`launch:log` 事件）；
 *     3. 「查看上次启动日志」时把核心写的文件读回来。
 *   曾经两边都写同一个文件 → 日志里每行都出现两遍。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_BUFFER_LINES = 5000;

class LaunchLog {
  constructor() {
    this.file = null;
    this.buffer = [];
    this.listeners = new Set();
  }

  /** 开始一次新的启动/安装会话（只重置缓冲与路径，不碰文件） */
  open(homeDir, tag = 'launch') {
    const dir = path.join(homeDir, 'logs');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* 目录建不出来也不该拖垮启动 */
    }
    this.file = path.join(dir, 'latest.log');
    this.buffer = [];
    this.write(`===== QCL ${tag} @ ${new Date().toLocaleString('zh-CN')} =====`);
    return this.file;
  }

  write(line) {
    const text = String(line ?? '');
    for (const part of text.split(/\r?\n/)) {
      if (!part && text.length) continue;
      this.buffer.push(part);
      if (this.buffer.length > MAX_BUFFER_LINES) this.buffer.splice(0, this.buffer.length - MAX_BUFFER_LINES);
      for (const fn of this.listeners) {
        try {
          fn(part);
        } catch {
          /* 忽略监听器异常 */
        }
      }
    }
  }

  onLine(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 读上一次的日志尾部（来自核心写的文件；进程重启后也能看） */
  recent(homeDir, limit = 500) {
    const candidates = [this.file, path.join(homeDir, 'logs', 'latest.log')].filter(Boolean);
    for (const file of candidates) {
      try {
        const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        const lines = raw.split(/\r?\n/);
        return lines.slice(Math.max(0, lines.length - limit));
      } catch {
        /* 换下一个候选 */
      }
    }
    return [];
  }

  snapshot() {
    return this.buffer.slice();
  }

  close() {
    this.buffer = [];
    this.file = null;
  }
}

module.exports = { LaunchLog };
