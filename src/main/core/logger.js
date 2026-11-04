'use strict';
/*
 * logger.js —— <QCL_HOME>/logs/latest.log 写入器（UTF-8 无 BOM）。
 *
 * 契约 §4 / §6 要求：安装与启动日志写到 <QCL_HOME>/logs/latest.log（覆盖式）。
 * 覆盖式 = 每次「开始安装」或「开始启动」时把文件截断，之后逐行追加，
 * 这样「查看上次启动日志」读到的永远是最近一次的真实输出。
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths');

function stamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 创建一个日志写入器。
 * @param {string} home QCL 主目录
 * @param {{reset?:boolean, echo?:Function}} [options] reset=true 时以覆盖方式开始
 */
function createLogger(home, options) {
  const opts = options || {};
  const file = paths.latestLog(home);
  try {
    paths.ensureDir(path.dirname(file));
    if (opts.reset) fs.writeFileSync(file, '', { encoding: 'utf8' });
  } catch (_) {
    /* 日志写不了（磁盘满 / 无权限）不应该影响安装本身 */
  }

  let echo = typeof opts.echo === 'function' ? opts.echo : null;

  const write = (line) => {
    const text = String(line == null ? '' : line);
    const out = /^\[\d{4}-\d{2}-\d{2} /.test(text) ? text : `[${stamp()}] ${text}`;
    try {
      fs.appendFileSync(file, `${out}\n`, { encoding: 'utf8' });
    } catch (_) {
      /* ignore */
    }
  };

  return {
    file,
    /** 写一行（自动加时间戳） */
    log(line) {
      write(line);
      if (echo) echo(String(line == null ? '' : line));
    },
    /** 原样写（已经带了时间戳或本来就是游戏原始输出） */
    raw(line) {
      write(line);
      if (echo) echo(String(line == null ? '' : line));
    },
    /** 只推给界面、不落盘（例如逐行游戏输出同时也在落盘，用 raw 更合适） */
    setEcho(fn) {
      echo = typeof fn === 'function' ? fn : null;
    },
    tail(limit) {
      return require('./jsonstore').readTailLines(file, limit || 200);
    },
    clear() {
      try {
        fs.writeFileSync(file, '', { encoding: 'utf8' });
      } catch (_) {
        /* ignore */
      }
    },
  };
}

module.exports = { createLogger, stamp };
