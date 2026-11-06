'use strict';
/**
 * Quanta Craft Launcher PC · 让玩家在程序目录里「看得到自己的实例」
 *
 * ## 问题（用户实机反馈）
 * 装完之后打开 `C:\Users\<用户>\AppData\Local\Programs\QCL`，里面只有
 * QCL.exe / resources / locales / QCL-data（残缺的缓存），
 * **找不到 instances / accounts / meta** —— 玩家以为数据丢了。
 * 真实数据在 `文档\QCL`（安装版的惯例位置），但玩家不会去那里找。
 *
 * ## 做法（对齐 MultiMC 的「打开程序目录就能看到 instances」体验）
 * 在程序目录里建一个**目录联接（junction）**指向真实主目录：
 *
 *     Programs\QCL\QCL数据 → 文档\QCL
 *
 * 为什么用 junction 而不是符号链接：
 *   · `mklink /J` **不需要管理员权限**（实测本机软链接报「需要管理员权限」，junction 可以）
 *   · 对资源管理器/程序完全透明，点进去就是真实目录的内容
 *   · 删除 junction 不会删除目标数据（`rmdir` 只断链）
 *
 * 为什么叫「QCL数据」而不是 `QCL-data`：
 *   安装包里已经有一个 `QCL-data`（Electron 的 userData 缓存目录），重名会互相干扰。
 *
 * ## 安全性
 *   · 目标目录不存在就直接返回，绝不乱建
 *   · 已存在同名目录时**不覆盖**（可能是玩家自己建的）
 *   · 建失败只写日志，绝不拦启动
 *   · 只在「安装版」尝试（便携版数据本来就在程序目录，不需要）
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** 程序目录里那个可见入口的名字 */
const LINK_NAME = 'QCL数据';

/** 拿到程序所在目录（打包后是安装目录，开发时是工程根） */
function programDir() {
  try {
    // ★ 只认 QCL.exe —— 打包后的产物名（electron-builder.config.js 里 executableName: 'QCL'）。
    //   开发时 process.execPath 是 node_modules\electron\dist\electron.exe，
    //   若按「含 electron 就算程序目录」判断，会把链接建到 node_modules 里去（实测踩到）。
    const exeDir = path.dirname(process.execPath);
    const exeName = path.basename(process.execPath).toLowerCase();
    if (/^qcl(\.exe)?$/.test(exeName)) return exeDir;
    // 开发环境：工程根（src/main/core 往上三级）
    return path.resolve(__dirname, '..', '..', '..');
  } catch {
    return process.cwd();
  }
}

/** 判断某个路径是不是目录联接/符号链接（不会跟随） */
function isLink(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 确保程序目录里有一个指向 `home` 的可见入口。
 *
 * @param {string} home  真实数据目录（如 文档\QCL）
 * @param {{log?:Function, name?:string}} [opts]
 * @returns {{created:boolean, skipped:string, link:string}}
 */
function ensureVisibleLink(home, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const name = String(opts.name || LINK_NAME);
  const out = { created: false, skipped: '', link: '' };

  const target = String(home || '').trim();
  if (!target) {
    out.skipped = '没有主目录';
    return out;
  }
  // 目标必须真的存在（绝不凭空建）
  try {
    if (!fs.statSync(target).isDirectory()) {
      out.skipped = '主目录不是文件夹';
      return out;
    }
  } catch {
    out.skipped = '主目录不存在';
    return out;
  }

  // 只有 Windows 的 junction 不需要管理员；其它平台跳过
  if (process.platform !== 'win32') {
    out.skipped = '非 Windows，跳过';
    return out;
  }

  const dir = programDir();
  const link = path.join(dir, name);
  out.link = link;

  // 程序目录 == 数据目录（便携版）：本来就能看到，不需要链
  try {
    if (path.resolve(dir) === path.resolve(target)) {
      out.skipped = '便携版：数据就在程序目录';
      return out;
    }
  } catch {
    /* ignore */
  }

  // 已经存在：链路正常就够了；若是同名真目录，绝不覆盖
  try {
    if (fs.existsSync(link) || isLink(link)) {
      if (isLink(link)) {
        out.skipped = '入口已存在';
        return out;
      }
      out.skipped = '程序目录里已有同名文件夹，未覆盖';
      return out;
    }
  } catch {
    /* ignore */
  }

  /**
   * ★★★ 建目录联接。优先用 Node 原生 fs.symlinkSync 的 'junction' 类型：
   *   · 它内部就是 CreateSymbolicLinkW 的 junction 分支，**不需要管理员权限**
   *   · 实测比 `cmd /c mklink /J` 更可靠 —— 后者在 Electron 渲染/受限子进程里
   *     会返回「拒绝访问」（cmd 本身要起 conhost，某些策略下被拦），而 Node API 直接调 Win32。
   */
  let made = false;
  try {
    fs.symlinkSync(target, link, 'junction');
    made = true;
  } catch (err1) {
    // 回退：cmd /c mklink /J（纯 node 环境实测可用）
    try {
      execFileSync('cmd', ['/c', 'mklink', '/J', link, target], {
        windowsHide: true,
        stdio: 'pipe',
        timeout: 15000,
      });
      made = true;
    } catch (err2) {
      let detail = '';
      try {
        const stderr = err2 && err2.stderr ? Buffer.from(err2.stderr).toString('utf8').trim() : '';
        if (stderr) detail = stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
      } catch {
        /* ignore */
      }
      out.skipped = `建立失败${detail ? `：${detail}` : `：${err2 && err2.message ? err2.message : err2}`}`;
      log(`建立程序目录数据入口失败（不影响使用）${out.skipped}`);
      // 兜底：写指路文件，玩家照样能找到数据
      try {
        const guide = path.join(dir, `${LINK_NAME}-在这里.txt`);
        const body = [
          'QCL 电脑版 · 你的数据在哪里',
          '',
          '实例、账号、模组、存档都保存在这里：',
          '  ' + target,
          '',
          '把上面那行路径复制到文件资源管理器地址栏回车就能进去。',
          '（程序目录里本想放一个叫「' + LINK_NAME + '」的快捷入口，',
          '   但这台机器的权限不允许建立目录联接，所以改成这份说明文件。）',
          '',
          '记于：' + new Date().toLocaleString('zh-CN'),
        ].join('\r\n');
        fs.writeFileSync(guide, body, 'utf8');
        out.guide = guide;
      } catch {
        /* 写不进去就算了 */
      }
    }
  }

  if (made) {
    out.created = true;
    log(`已在程序目录建立数据入口：${link} → ${target}`);
  }
  return out;
}

/** 移除入口（只断链，不动数据）。卸载/迁移时用。 */
function removeVisibleLink(opts = {}) {
  const link = path.join(programDir(), String(opts.name || LINK_NAME));
  if (!isLink(link)) return { removed: false, reason: '不存在或不是链接' };
  try {
    // 用 rmdir 断链：对 junction 安全，不会动目标内容
    fs.rmdirSync(link);
    return { removed: true };
  } catch (err) {
    return { removed: false, reason: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  LINK_NAME,
  programDir,
  isLink,
  ensureVisibleLink,
  removeVisibleLink,
};
