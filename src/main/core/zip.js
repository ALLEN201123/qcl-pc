'use strict';
/*
 * zip.js —— 最小 ZIP 读取器（只依赖 node:zlib）。
 *
 * 为什么不用第三方库：契约要求零第三方依赖；natives / assets 解压量大，
 * 调 PowerShell Expand-Archive 每个 jar 都要起一次进程太慢，所以自己解析
 * 中央目录 + inflateRaw 解 deflate。
 *
 * 支持：store(0) / deflate(8)；ZIP64 不处理（Minecraft 的 jar 用不到）。
 */

const fs = require('node:fs');
const zlib = require('node:zlib');

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** 把 UTF-8 字节按 ZIP 约定解码（bit 11 置位时才是 UTF-8，但 Java jar 基本都是）。 */
function decodeName(buf, flags) {
  const utf8 = (flags & 0x0800) !== 0;
  if (utf8) return buf.toString('utf8');
  // 未声明 UTF-8 时按 CP437 近似：ASCII 段直接读，非 ASCII 用 latin1 兜底
  const latin = buf.toString('latin1');
  return /^[\x00-\x7f]*$/.test(latin) ? latin : buf.toString('utf8');
}

function findEocd(buf) {
  const min = 22;
  if (buf.length < min) return -1;
  const start = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - min; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 打开一个 ZIP（整文件读入内存）。
 * natives 只有几百 KB，client.jar 我们不从这里解压，所以内存占用可接受。
 */
function open(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error(`不是合法的 ZIP 文件（找不到中央目录结尾）：${zipPath}`);

  let entryCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64：本实现只在「值被写成 0xFFFFFFFF 占位」时尝试读 locator
  if (entryCount === 0xffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === SIG_EOCD64_LOCATOR) {
      const z64 = Number(buf.readBigUInt64LE(locator + 8));
      if (z64 >= 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === 0x06064b50) {
        entryCount = Number(buf.readBigUInt64LE(z64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const entries = [];
  let cursor = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== SIG_CENTRAL) break;
    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const crc32 = buf.readUInt32LE(cursor + 16);
    let compSize = buf.readUInt32LE(cursor + 20);
    let uncompSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    let localOffset = buf.readUInt32LE(cursor + 42);
    const name = decodeName(buf.subarray(cursor + 46, cursor + 46 + nameLen), flags);

    // 中央目录里的 extra 字段可能带 ZIP64 的 8 字节尺寸
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      let p = cursor + 46 + nameLen;
      const end = p + extraLen;
      while (p + 4 <= end) {
        const hid = buf.readUInt16LE(p);
        const hsz = buf.readUInt16LE(p + 2);
        if (hid === 0x0001) {
          let q = p + 4;
          if (uncompSize === 0xffffffff && q + 8 <= p + 4 + hsz) {
            uncompSize = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
          if (compSize === 0xffffffff && q + 8 <= p + 4 + hsz) {
            compSize = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
          if (localOffset === 0xffffffff && q + 8 <= p + 4 + hsz) {
            localOffset = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
          break;
        }
        p += 4 + hsz;
      }
    }

    entries.push({
      name,
      isDirectory: name.endsWith('/'),
      method,
      crc32,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      localOffset,
    });
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  /** 取出某个条目的原始数据（按需解压）。 */
  function readEntry(entry) {
    const lh = entry.localOffset;
    if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== SIG_LOCAL) {
      throw new Error(`ZIP 条目 ${entry.name} 的本地头损坏`);
    }
    const nameLen = buf.readUInt16LE(lh + 26);
    const extraLen = buf.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method === 8) {
      const out = zlib.inflateRawSync(raw);
      return out;
    }
    throw new Error(`ZIP 条目 ${entry.name} 使用了不支持的压缩方式（method=${entry.method}）`);
  }

  return { path: zipPath, entries, readEntry };
}

/** 列出条目名。 */
function list(zipPath) {
  return open(zipPath).entries.map((e) => e.name);
}

module.exports = { open, list };
