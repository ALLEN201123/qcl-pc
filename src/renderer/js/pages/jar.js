/**
 * QCL 电脑版 · JAR 启动
 *
 * 照安卓版 1.5.2 的「JAR 启动」：自己挑一个 jar，用 QCL 管理的 Java 直接跑，
 * 不经过版本实例（适合跑服务端核心、整合包安装器、小工具）。
 *
 * ⚠ 契约 v1 里还没有专门给 JAR 启动的通道，本页会尝试 `launch:jar`；
 *   如果主进程还没实现，会显示中文提示并指出缺哪个通道（不做假按钮）。
 */

import { call } from '../bridge.js';
import { state, loadJava } from '../store.js';
import { html, raw, setHTML, toast } from '../ui.js';
import { icon } from '../icons.js';

export const jarPage = {
  id: 'jar',
  title: 'JAR 启动',
  async render(mount) {
    await loadJava();
    const L = state.settings.launch;
    const rememberedMb = (state.settings.memory && state.settings.memory.mb) || 2048;

    setHTML(
      mount,
      html`<div class="page page--panel">
        <div class="page__head">
          <div class="page__title">JAR 启动</div>
          <div class="page__sub">用指定 Java 直接运行一个 jar，不经过版本实例</div>
        </div>
        <div class="page__body">
          <div class="jar">
            <div class="card">
              <div class="card__title">要运行的文件</div>
              <div class="field">
                <div class="field__label">jar 完整路径</div>
                <div class="field__row">
                  <input class="input" id="jr-path" placeholder="D:\\服务端\\server.jar" autocomplete="off" />
                  <button class="btn btn--ghost" id="jr-open" type="button">${raw(icon('folder', 14))}打开所在目录</button>
                </div>
                <div class="field__hint" id="jr-info">
                  例如服务端核心 <span class="mono">server.jar</span>、整合包安装器 <span class="mono">installer.jar</span>。
                  QCL 不会改动这个文件。
                </div>
              </div>
            </div>

            <div class="card">
              <div class="card__title">运行参数</div>
              <div class="field">
                <div class="field__label">使用的 Java</div>
                <select class="select" id="jr-java">
                  <option value="">跟随全局设置（自动检测）</option>
                  ${state.java.map(
                    (j) => raw(`<option value="${j.path}"${state.settings.javaPath === j.path ? ' selected' : ''}>${j.version} · ${j.arch} · ${j.vendor}</option>`)
                  )}
                </select>
              </div>
              <div class="field">
                <div class="field__label">
                  最大内存
                  <span class="grow"></span>
                  <span class="mono" id="jr-mem-value">${rememberedMb} MB</span>
                </div>
                <input class="slider" id="jr-mem" type="range" min="512" max="16384" step="512" value="${rememberedMb}" />
              </div>
              <div class="field">
                <div class="field__label">附加启动参数</div>
                <input class="input" id="jr-args" placeholder="-Dfile.encoding=UTF-8 nogui" value="${L.extraJvmArgs || ''}" />
                <div class="field__hint">按空格分隔。服务端核心通常要加 <span class="mono">nogui</span>。</div>
              </div>
            </div>

            <div class="card">
              <div class="card__title">工作目录</div>
              <div class="field">
                <div class="field__label">Java 进程的工作目录</div>
                <input class="input" id="jr-cwd" placeholder="留空 = jar 文件所在目录" />
                <div class="field__hint">服务端会把世界存档、配置写在当前工作目录下，注意别和别的服务端混在一起。</div>
              </div>
            </div>

            <div class="hstack">
              <button class="btn" id="jr-run" type="button">${raw(icon('play', 14))}启动</button>
              <button class="btn btn--ghost" id="jr-log" type="button">查看启动日志</button>
            </div>

            <div class="card" id="jr-result-card" style="display:none">
              <div class="card__title">运行结果</div>
              <div class="about__text" id="jr-result"></div>
            </div>
          </div>
        </div>
      </div>`
    );

    const pathEl = mount.querySelector('#jr-path');
    const infoEl = mount.querySelector('#jr-info');
    const resultCard = mount.querySelector('#jr-result-card');
    const resultEl = mount.querySelector('#jr-result');

    function updateInfo() {
      const p = pathEl.value.trim();
      if (!p) {
        setHTML(infoEl, html`填一个 jar 的完整路径，然后点「启动」。`);
        return;
      }
      const name = p.split(/[\\/]/).pop();
      const dir = p.replace(/[\\/][^\\/]*$/, '');
      if (!/\.jar$/i.test(p)) {
        setHTML(infoEl, html`<span class="badge badge--warn">这不是 .jar 文件</span> 当前选择：<span class="mono">${name}</span>`);
        return;
      }
      setHTML(infoEl, html`文件：<strong>${name}</strong><br />目录：<span class="mono">${dir}</span>`);
    }

    pathEl.addEventListener('input', updateInfo);
    updateInfo();

    const mem = mount.querySelector('#jr-mem');
    const memVal = mount.querySelector('#jr-mem-value');
    mem.addEventListener('input', () => (memVal.textContent = `${mem.value} MB`));

    mount.querySelector('#jr-open').addEventListener('click', async () => {
      const p = pathEl.value.trim();
      if (!p) {
        toast('请先填写 jar 路径', 'warn');
        return;
      }
      const dir = p.replace(/[\\/][^\\/]*$/, '');
      const r = await call('shell:openPath', { path: dir });
      if (!r.ok) toast(r.error || '打开目录失败（路径可能不存在）', 'error', 5000);
    });

    mount.querySelector('#jr-log').addEventListener('click', async () => {
      const m = await import('../router.js');
      m.navigate('log');
    });

    mount.querySelector('#jr-run').addEventListener('click', async () => {
      const p = pathEl.value.trim();
      if (!p) {
        toast('请先填写要运行的 jar 路径', 'warn');
        return;
      }
      if (!/\.jar$/i.test(p)) {
        toast('请选择 .jar 文件', 'warn');
        return;
      }
      const payload = {
        jarPath: p,
        javaPath: mount.querySelector('#jr-java').value || null,
        memoryMb: Number(mem.value),
        args: mount.querySelector('#jr-args').value.trim(),
        cwd: mount.querySelector('#jr-cwd').value.trim() || null,
      };
      resultCard.style.display = '';
      setHTML(resultEl, html`正在提交启动请求…`);

      const r = await call('launch:jar', payload);
      if (r.ok) {
        setHTML(resultEl, html`已提交启动请求。<br />如果要看输出，去「启动日志」页。`);
        toast('已开始运行 JAR', 'ok', 3000);
        return;
      }
      setHTML(
        resultEl,
        html`启动请求没有成功。<br /><br />
          <strong>原因：</strong>${r.error || '未知'}<br /><br />
          <span class="muted">
            「JAR 启动」需要主进程提供一个专门的通道（建议名 <span class="mono">launch:jar</span>，
            入参 <span class="mono">{ jarPath, javaPath, memoryMb, args, cwd }</span>），
            因为 <span class="mono">launch:start</span> 只接受实例 id，无法直接跑任意外部 jar。
            这里已经按上面的入参发起调用，主进程一旦补上该通道，本页无需改动即可生效。
          </span>`
      );
      toast(r.error || 'JAR 启动失败', 'error', 6000);
    });

    return {};
  },
};

export default jarPage;
