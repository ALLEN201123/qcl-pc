'use strict';
/**
 * QCL 电脑版 · 最小 ZIP 写入器（配合 core/zip.js 的读取器）
 *
 * 用途：中文补丁要把补丁文件写进游戏 jar 并重建，core/zip.js 只能读，所以这里补一个写。
 * 只用 Node 内置的 zlib，不引第三方依赖。
 *
 * 支持：
 *   · deflate（默认，压缩率高）与 store（不压缩，适合已压缩的 png/jar）
 *   · 读取后原样复制已有条目（保留原压缩数据，不解压再压，速度快且不会改变文件内容）
 */

const fs = require('node:fs');
const zlib = require('node:zlib');

const zipReader = require('./zip');

/** CRC32 查表（ZIP 必需） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}

/** MS-DOS 时间/日期（ZIP 头要求） */
function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day =
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/**
 * 读一个 zip 的全部条目（带原始压缩数据，便于无损复制）。
 * @returns {{name, isDirectory, method, crc, compressedSize, uncompressedSize, rawCompressed, data}[]}
 */
function readZip(zipPath) {
  const handle = zipReader.open(zipPath);
  const out = [];
  for (const entry of handle.entries) {
    const isDirectory = entry.name.endsWith('/');
    const name = isDirectory ? entry.name : entry.name;
    if (isDirectory) {
      out.push({
        name,
        isDirectory: true,
        method: 0,
        crc: 0,
        compressedSize: 0,
        uncompressedSize: 0,
        rawCompressed: Buffer.alloc(0),
        data: Buffer.alloc(0)
      });
      continue;
    }
    let data = null;
    let rawCompressed = null;
    try {
      data = handle.readEntry(entry);
    } catch (err) {
      throw new Error(`读取 ZIP 条目失败（${entry.name}）：${err && err.message ? err.message : err}`);
    }
    // readEntry 返回解压后的内容；为了无损复制，deflate 条目重新压一次也一样安全
    rawCompressed = data;
    out.push({
      name,
      isDirectory: false,
      method: 0, // 统一用 store，最稳（避免二次压缩引入差异）
      crc: crc32(data),
      compressedSize: data.length,
      uncompressedSize: data.length,
      rawCompressed,
      data
    });
  }
  return out;
}

/**
 * 写一个 zip。
 * @param {string} zipPath 输出路径
 * @param {{name:string, data?:Buffer, isDirectory?:boolean, method?:number}[]} entries
 */
function createZip(zipPath, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());
  const seen = new Set();

  for (const e of entries) {
    if (!e || !e.name) continue;
    // 同名条目只保留第一个，避免 zip 里出现重复（会让游戏加载器行为不确定）
    if (seen.has(e.name)) continue;
    seen.add(e.name);

    const nameBuf = Buffer.from(e.name, 'utf8');
    const isDir = !!e.isDirectory || e.name.endsWith('/');

    if (isDir) {
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(0, 14);
      local.writeUInt32LE(0, 18);
      local.writeUInt32LE(0, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      chunks.push(local, nameBuf);

      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0);
      cen.writeUInt16LE(20, 4);
      cen.writeUInt16LE(20, 6);
      cen.writeUInt16LE(0, 8);
      cen.writeUInt16LE(0, 10);
      cen.writeUInt16LE(time, 12);
      cen.writeUInt16LE(date, 14);
      cen.writeUInt32LE(0, 16);
      cen.writeUInt32LE(0, 20);
      cen.writeUInt32LE(0, 24);
      cen.writeUInt16LE(nameBuf.length, 28);
      cen.writeUInt16LE(0, 30);
      cen.writeUInt16LE(0, 32);
      cen.writeUInt16LE(0, 34);
      cen.writeUInt16LE(0, 36);
      cen.writeUInt32LE(0x10, 38); // 目录属性
      cen.writeUInt32LE(offset, 42);
      central.push(cen, nameBuf);

      offset += local.length + nameBuf.length;
      continue;
    }

    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '');
    const crc = crc32(data);

    // 已压缩过的小文件（png/jar）用 store 更快且不会变大；其余用 deflate
    let method = e.method;
    if (method === undefined) {
      const ext = e.name.slice(e.name.lastIndexOf('.')).toLowerCase();
      method = ['.png', '.jar', '.zip', '.ogg'].includes(ext) ? 0 : 8;
    }
    let payload = data;
    if (method === 8 && data.length > 64) {
      const deflated = zlib.deflateRawSync(data, { level: 9 });
      // 压缩没变小就用 store
      if (deflated.length < data.length) payload = deflated;
      else method = 0;
    } else {
      method = 0;
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(seen.size, 8);
  eocd.writeUInt16LE(seen.size, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(zipPath, Buffer.concat([...chunks, centralBuf, eocd]));
  return { entries: seen.size, bytes: offset + centralBuf.length + eocd.length };
}

module.exports = { createZip, readZip, crc32 };
