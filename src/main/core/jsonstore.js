'use strict';
/*
 * jsonstore.js —— JSON 持久化。
 *
 * 原子写：先写同目录的 <file>.<pid>.<seq>.tmp，写完再 rename 覆盖目标。
 *   Windows 上 fs.renameSync 走 MoveFileEx(MOVEFILE_REPLACE_EXISTING)，
 *   覆盖已存在文件是允许的，所以不会出现「写一半断电 → 文件损坏」。
 * 读坏 JSON：返回默认值的深拷贝，绝不把异常抛给调用方。
 */

const fs = require('node:fs');
const path = require('node:path');

let tmpSeq = 0;

/** 深拷贝默认值，避免调用方拿到同一个对象引用后互相污染。 */
function cloneDefault(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch (_) {
      /* 含函数等不可克隆值时退到 JSON 深拷贝 */
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return value;
  }
}

/**
 * 读取 JSON；文件不存在 / 解析失败 / 权限异常都返回 fallback 的深拷贝。
 * @param {string} file
 * @param {*} fallback
 */
function readJson(file, fallback) {
  if (!file) return cloneDefault(fallback);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return cloneDefault(fallback);
  }
  // 去掉 UTF-8 BOM（Windows 记事本另存过就会带）
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return cloneDefault(fallback);
  try {
    const parsed = JSON.parse(text);
    return parsed === undefined || parsed === null ? cloneDefault(fallback) : parsed;
  } catch (_) {
    return cloneDefault(fallback);
  }
}

/**
 * 原子写 JSON（UTF-8 无 BOM，两空格缩进便于人工查看）。
 * @param {string} file
 * @param {*} data
 */
function writeJson(file, data) {
  if (!file) throw new Error('JSON 写入失败：没有给出文件路径');
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${tmpSeq++}.tmp`);
  const text = JSON.stringify(data, null, 2) + '\n';
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8' });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_) {
      /* 清理失败不影响主错误 */
    }
    throw new Error(`JSON 写入失败（${file}）：${err && err.message ? err.message : String(err)}`);
  }
}

/** 读-改-写：文件不存在或损坏时以 fallback 为起点，交给 mutator 修改后原子落盘。 */
function updateJson(file, fallback, mutator) {
  const current = readJson(file, fallback);
  const next = typeof mutator === 'function' ? mutator(current) : mutator;
  writeJson(file, next === undefined ? current : next);
  return next === undefined ? current : next;
}

/* ------------------------------------------------------------ 文本文件工具 */

/** 读 UTF-8 文本（去 BOM）；不存在返回 fallback。 */
function readText(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  } catch (_) {
    return fallback === undefined ? null : fallback;
  }
}

/** 原子写 UTF-8 文本（无 BOM）。 */
function writeText(file, text) {
  if (!file) throw new Error('文本写入失败：没有给出文件路径');
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${tmpSeq++}.tmp`);
  try {
    fs.writeFileSync(tmp, String(text), { encoding: 'utf8' });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_) {
      /* ignore */
    }
    throw new Error(`文本写入失败（${file}）：${err && err.message ? err.message : String(err)}`);
  }
}

/** 追加一行 UTF-8 文本（给日志用，不追求原子性）。 */
function appendLine(file, line) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, String(line) + '\n', { encoding: 'utf8' });
}

/** 读文件尾部最多 maxLines 行（给「查看上次启动日志」用）。 */
function readTailLines(file, maxLines) {
  const limit = Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : 200;
  const text = readText(file, null);
  if (text == null) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-limit);
}

module.exports = {
  readJson,
  writeJson,
  updateJson,
  readText,
  writeText,
  appendLine,
  readTailLines,
};
