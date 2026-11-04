/**
 * QCL 电脑版 · 关于
 *
 * 全部外链一律走 `shell:openExternal`（渲染层不自己跳外链，契约由 window.js 兜底）。
 */

import { call } from '../bridge.js';
import { state } from '../store.js';
import { html, raw, setHTML, toast } from '../ui.js';
import { icon } from '../icons.js';

/** ★ QCL 电脑版自己的仓库（2026-11-05 已建好；安卓版是 Quanta-Craft-Launcher，别混） */
const GITHUB = 'https://github.com/ALLEN201123/qcl-pc';
const RELEASES = 'https://github.com/ALLEN201123/qcl-pc/releases';
const BILI = 'https://space.bilibili.com/550905358';

const FEATURES = [
  ['远古版本是看家本领', '唯一支持下载考古社区全部归档远古版本（pre-classic / classic / indev / infdev / alpha / beta / RC，共 258 个归档构建）的启动器，并唯一为全部远古版本提供中文补丁。'],
  ['版本覆盖面广', '从 rd-132211 一直到 26.x（Java 25）都能装、能启动。'],
  ['自研启动链路', '1.1.1 起启动链路、输入桥、Java 运行时链路全部自研；窗口、Surface、EGL 上下文、帧节奏亦自研（渲染器本身仍是第三方库）。'],
  ['实例隔离', '照 MultiMC 的实例模型：每个实例独立 .minecraft，互不干扰，共享 meta 缓存。'],
  ['真实进度', '下载按文件数与字节数计算真实进度，支持并发线程、sha1 校验、失败重试。'],
  ['多下载源', '官方源 / BMCLAPI 镜像一键切换，国内网络明显更快。'],
];

export const aboutPage = {
  id: 'about',
  title: '关于 QCL',
  async render(mount) {
    const a = state.appInfo;

    setHTML(
      mount,
      html`<div class="page page--panel">
        <div class="page__head">
          <div class="page__title">关于 QCL</div>
          <div class="page__sub">Quanta Craft Launcher PC · 量子方块启动器</div>
        </div>
        <div class="page__body">
          <div class="about">
            <div class="about__hero">
              <div class="about__logo" aria-hidden="true"></div>
              <div>
                <div class="about__name">Quanta Craft Launcher PC</div>
                <div class="about__tag">Quanta Craft Launcher · Minecraft: Java Edition 启动器 · 电脑版 ${a.version}</div>
                <div class="about__tag">作者 Rod123456 · 许可 GNU GPL-3.0</div>
              </div>
            </div>

            <div class="card">
              <div class="card__title">QCL 是什么</div>
              <div class="about__text">
                QCL 是一个 Minecraft Java 版启动器。<strong>它的主攻方向是「远古版本」</strong>：
                pre-classic、classic、indev、infdev、alpha、beta、RC —— 那些官方启动器早就不管的版本，
                QCL 不但能装、能启动，还提供中文补丁。<br /><br />
                同时，常规的正式版与快照也一并支持，从最早的 <span class="mono">rd-132211</span>
                一直到 <span class="mono">26.x</span>（需要 Java 25）。<br /><br />
                这个界面是<strong>电脑版（Electron 桌面端）</strong>，照安卓版 1.5.x 的「新排版」1:1 还原：
                左侧常驻图标栏、中间公告 + 3D 人物、右侧常驻账号与启动栏，整窗无边框、
                壁纸铺到窗口物理边缘，所有面板都是浮在壁纸上的半透明层。
              </div>
            </div>

            <div class="card">
              <div class="card__title">功能特点</div>
              <div class="about__text">
                <ul>
                  ${FEATURES.map(([t, d]) => raw(`<li><strong>${t}</strong>：${d}</li>`))}
                </ul>
              </div>
            </div>

            <div class="card">
              <div class="card__title">许可与来源</div>
              <div class="about__text">
                本项目以 <strong>GNU General Public License v3.0</strong> 发布。你可以自由使用、修改、再分发，
                但衍生作品必须以同样的许可开源。<br /><br />
                启动核心逻辑参照 <span class="mono">MultiMC</span>（C++/Qt，Apache-2.0）的公开源码实现；
                界面资源（壁纸、图标）来自 QCL 安卓版项目自身，未使用任何第三方版权素材。
              </div>
              <div class="kv" style="margin-top:10px">
                <div class="kv__k">版本</div>
                <div class="kv__v">${a.name} ${a.version}</div>
                <div class="kv__k">平台</div>
                <div class="kv__v">${a.platform} · ${a.arch}</div>
                <div class="kv__k">主目录</div>
                <div class="kv__v mono">${state.settings.home || '未获取'}</div>
                <div class="kv__k">连接状态</div>
                <div class="kv__v">${state.connected ? '主进程已连接' : '未连接到主进程（显示示例数据）'}</div>
              </div>
            </div>

            <div class="card">
              <div class="card__title">链接</div>
              <div class="hstack" style="flex-wrap:wrap;gap:8px">
                <button class="btn" id="ab-github" type="button">${raw(icon('external', 14))}GitHub 仓库</button>
                <button class="btn btn--ghost" id="ab-releases" type="button">${raw(icon('external', 14))}下载最新版</button>
                <button class="btn btn--ghost" id="ab-bili" type="button">${raw(icon('external', 14))}作者的 B 站</button>
                <button class="btn btn--ghost" id="ab-copy" type="button">复制仓库地址</button>
              </div>
              <div class="field__hint" style="margin-top:8px">
                <span class="mono">${GITHUB}</span>
              </div>
            </div>

            <div class="card">
              <div class="card__title">免责声明</div>
              <div class="about__text">
                QCL 是非官方启动器，与 Mojang Studios、Microsoft 无任何隶属关系。
                Minecraft 是 Mojang Studios 的商标。使用正版账号登录以获得完整体验；
                请勿使用本软件从事任何侵犯著作权的行为。
              </div>
            </div>

            <div class="about__text muted" style="text-align:center;padding-bottom:8px">
              © 2026 Rod123456 · Quanta Craft Launcher PC · GPL-3.0
            </div>
          </div>
        </div>
      </div>`
    );

    async function open(url, label) {
      const r = await call('shell:openExternal', { url });
      if (!r.ok) toast(r.error || `打开${label}失败`, 'error', 5000);
    }

    mount.querySelector('#ab-github').addEventListener('click', () => open(GITHUB, 'GitHub 仓库'));
    mount.querySelector('#ab-releases').addEventListener('click', () => open(RELEASES, '下载页'));
    mount.querySelector('#ab-bili').addEventListener('click', () => open(BILI, 'B 站主页'));
    mount.querySelector('#ab-copy').addEventListener('click', async () => {
      const m = await import('../ui.js');
      m.copyText(GITHUB);
    });

    return {};
  },
};

export default aboutPage;
