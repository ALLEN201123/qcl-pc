'use strict';
/**
 * 静态检查：渲染层的 import 是否都能解析到真实导出。
 *
 * 为什么需要它：Electron 里模块解析失败只会报一行
 * 「Failed to resolve module specifier」或「does not provide an export named」，
 * 而且会让整个 app.js 模块链断掉 → 界面卡在启动画面。
 * 这个脚本在打包前跑一遍，能提前抓到这类错误。
 *
 * 用法：node build\check-imports.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');

/** 收集一个 js 文件的导出名 */
function collectExports(file) {
  const text = fs.readFileSync(file, 'utf8');
  const names = new Set();

  // export function xxx / export const xxx / export class xxx / export let xxx
  let m;
  const re1 = /export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = re1.exec(text))) names.add(m[1]);

  // export { a, b as c }
  const re2 = /export\s*\{([^}]*)\}/g;
  while ((m = re2.exec(text))) {
    for (const part of m[1].split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const asMatch = seg.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      names.add(asMatch ? asMatch[1] : seg.split(/\s+/)[0]);
    }
  }

  // export default
  if (/export\s+default\b/.test(text)) names.add('default');

  return names;
}

/** 收集一个 js 文件的 import 需求 */
function collectImports(file) {
  const text = fs.readFileSync(file, 'utf8');
  const list = [];
  let m;

  // import { a, b } from './x.js'
  const re1 = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = re1.exec(text))) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const asMatch = s.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
        return asMatch ? s.replace(/\bas\s+[A-Za-z_$][\w$]*$/, '').trim() : s;
      });
    list.push({ names, from: m[2] });
  }

  // import * as ns from './x.js'  （不校验具体名字）
  const re2 = /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = re2.exec(text))) list.push({ names: [], from: m[2], ns: m[1] });

  return list;
}

function main() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'vendor' || e.name === 'assets' || e.name === '_devtest') continue;
        walk(p);
      } else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) {
        files.push(p);
      }
    }
  };
  walk(RENDERER);

  let problems = 0;
  let checked = 0;

  for (const file of files) {
    const rel = path.relative(RENDERER, file);
    const imports = collectImports(file);
    for (const imp of imports) {
      // 跳过裸模块名（three 等由 importmap 提供）
      if (!imp.from.startsWith('.') && !imp.from.startsWith('/')) continue;
      const target = path.resolve(path.dirname(file), imp.from);
      if (!fs.existsSync(target)) {
        console.log(`❌ ${rel} → 找不到模块 ${imp.from}`);
        problems += 1;
        continue;
      }
      const exports = collectExports(target);
      for (const name of imp.names) {
        checked += 1;
        if (!exports.has(name)) {
          console.log(`❌ ${rel} → ${imp.from} 没有导出 "${name}"`);
          problems += 1;
        }
      }
    }
  }

  console.log(`\n检查了 ${files.length} 个文件、${checked} 个具名导入`);
  if (problems) {
    console.log(`❌ 发现 ${problems} 个问题`);
    process.exitCode = 1;
  } else {
    console.log('✅ 所有 import 都能解析到真实导出');
  }
}

main();
