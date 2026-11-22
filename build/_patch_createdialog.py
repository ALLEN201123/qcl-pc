# -*- coding: utf-8 -*-
"""把 server.js 里的「新建服务端对话框」整段替换成新版。

新版权衡：
1. 先弹窗、后异步填数据 —— 修复「点了卡成屎」（原来要等 server:options 拉 900+ 条版本清单才弹窗）
2. 版本分四组：正式版 / 快照 / 远古版本 / 手动填 —— 修复「没有远古版本、快照选项」
3. 核心加 forge / neoforge —— 修复「模组端没有 forge 和 neoforge」
"""
import io
import re
import sys

PATH = r"D:\HMCL-PE重构QCL计划\qcl-pc\src\renderer\js\pages\server.js"

src = io.open(PATH, encoding="utf-8").read()
lines = src.split("\n")

# 找到注释块起点（/*** 之前那行的 /** ）与 pendingCreateForm 那行
start = None
end = None
for i, line in enumerate(lines):
    if "2026-11-22 修（用户反馈「点新建服务端按钮还点不动」）" in line and start is None:
        # 往上找到 /**
        j = i
        while j > 0 and not lines[j].strip().startswith("/**"):
            j -= 1
        start = j
    if line.strip() == "let pendingCreateForm = null;" and end is None:
        # 往上找到 /** 暂存... */
        j = i
        while j > 0 and not lines[j].strip().startswith("/**"):
            j -= 1
        end = i  # 含这一行一起替换

if start is None or end is None:
    print("定位失败 start=%s end=%s" % (start, end))
    sys.exit(1)

print("替换行范围：%d .. %d（共 %d 行）" % (start + 1, end + 1, end - start + 1))

NEW = r'''/**
 * 新建服务端对话框。
 *
 * ★★★ 2026-11-22 第二次修（用户反馈三件事）：
 *
 *   ① 「点开新建，服务端会卡成屎」——
 *      初版是 `await call('server:options')` **之后**才弹窗，而 server:options 里
 *      要拉 Mojang 版本清单（900+ 条，走网络，首次可能几秒到十几秒），
 *      于是点了按钮半天没有任何反应，看起来就是卡死。
 *      ⇒ 改成**先弹窗（骨架）、后异步填数据**，弹窗立刻出来。
 *
 *   ② 「上面没有远古版本、快照版本的选项」——
 *      初版只有一个正式版下拉框 + 一个手填输入框。
 *      ⇒ 现在分四组：正式版 / 快照 / 远古版本 / 手动填。
 *        远古版来自 Betacraft 归档（Classic/Alpha/Beta/Infdev）+ 内置社区服务端；
 *        快照里还并入了「官方已删除、归档保留」的那批周快照。
 *
 *   ③ 「模组端没有 forge 和 neoforge」——
 *      核心列表补上 Forge 与 NeoForge。
 */

/** 新建对话框的版本数据缓存（页面级，避免每次开都重新拉） */
const createData = {
  releases: null,
  snapshots: null,
  ancient: null,
  builtin: null,
  loading: false,
  loadedAt: 0,
};

function kindLabelOf(kind) {
  return (
    {
      vanilla: '原版',
      paper: 'Paper',
      purpur: 'Purpur',
      fabric: 'Fabric',
      forge: 'Forge',
      neoforge: 'NeoForge',
    }[kind] || kind
  );
}

async function openCreateDialog() {
  /** 表单状态放闭包，不依赖 DOM 存活（openModal 关闭会清空 #modal-root） */
  const form = {
    name: '',
    kind: 'vanilla',
    group: 'release',
    version: '',
    manual: '',
  };

  const kindHint = {
    vanilla: '原版：Mojang 官方服务端。老版本会自动找 Betacraft 归档里官方已下架的那些。',
    paper: 'Paper：性能好、支持插件。支持 1.7.10 到最新（含 26.x）。',
    purpur: 'Purpur：Paper 的增强分支，配置项更多。',
    fabric: 'Fabric：轻量模组服，模组生态最活跃。',
    forge: 'Forge：老牌模组服，1.7.10 / 1.12.2 时代的整合包大多用它。',
    neoforge: 'NeoForge：Forge 的现代分支，1.20.2+ 的模组服首选。',
  };

  const body = `
    <div class="field">
      <div class="field__label">名称</div>
      <input class="input" id="sc-name" type="text" placeholder="例如 和朋友玩的世界" autocomplete="off" />
    </div>

    <div class="field">
      <div class="field__label">服务端核心</div>
      <div class="srv-kinds" id="sc-kinds">
        <button class="srv-kind is-active" type="button" data-kind="vanilla">原版</button>
        <button class="srv-kind" type="button" data-kind="paper">Paper</button>
        <button class="srv-kind" type="button" data-kind="purpur">Purpur</button>
        <button class="srv-kind" type="button" data-kind="fabric">Fabric</button>
        <button class="srv-kind" type="button" data-kind="forge">Forge</button>
        <button class="srv-kind" type="button" data-kind="neoforge">NeoForge</button>
      </div>
      <div class="field__hint" id="sc-kind-hint">原版：Mojang 官方服务端。老版本会自动找 Betacraft 归档里官方已下架的那些。</div>
    </div>

    <div class="field">
      <div class="field__label">版本类型</div>
      <div class="srv-vgroups" id="sc-vgroups">
        <button class="srv-vgroup is-active" type="button" data-group="release">正式版</button>
        <button class="srv-vgroup" type="button" data-group="snapshot">快照</button>
        <button class="srv-vgroup" type="button" data-group="ancient">远古版本</button>
        <button class="srv-vgroup" type="button" data-group="manual">手动填</button>
      </div>
    </div>

    <div class="field" id="sc-version-field">
      <div class="field__label">选择版本</div>
      <select class="input" id="sc-version">
        <option value="">正在加载版本清单…</option>
      </select>
      <div class="field__hint" id="sc-version-hint">正在后台加载，这期间可以先填名称、选核心</div>
    </div>

    <div class="field" id="sc-manual-field" hidden>
      <div class="field__label">手动填版本号</div>
      <input class="input" id="sc-version-manual" type="text" placeholder="例如 b1.7.3 / b1.9-pre1 / 1.0.0 / 13w16a" autocomplete="off" />
      <div class="field__hint">官方已下架的版本会自动从 Betacraft 归档拿</div>
    </div>

    <div class="field" id="sc-builtin-field" hidden>
      <div class="field__label">内置社区服务端</div>
      <div class="field__hint" id="sc-builtin-hint"></div>
    </div>
  `;

  const result = await openModal({
    title: '新建服务端',
    body,
    buttons: [
      { text: '取消', kind: 'ghost', value: 'cancel' },
      { text: '创建', value: 'ok' },
    ],
    onMount: (root) => {
      const $ = (sel) => root.querySelector(sel);
      const sync = () => {
        form.name = ($('#sc-name') && $('#sc-name').value) || '';
        form.manual = ($('#sc-version-manual') && $('#sc-version-manual').value) || '';
        const sel = $('#sc-version');
        if (sel && sel.value) form.version = sel.value;
      };

      if ($('#sc-name')) $('#sc-name').addEventListener('input', sync);
      if ($('#sc-version-manual')) $('#sc-version-manual').addEventListener('input', sync);
      if ($('#sc-version')) $('#sc-version').addEventListener('change', sync);

      root.querySelectorAll('[data-kind]').forEach((b) => {
        b.addEventListener('click', () => {
          form.kind = b.getAttribute('data-kind');
          root.querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('is-active', x === b));
          const h = $('#sc-kind-hint');
          if (h) h.textContent = kindHint[form.kind] || '';
          fillVersions(root, form);
        });
      });

      root.querySelectorAll('[data-group]').forEach((b) => {
        b.addEventListener('click', () => {
          form.group = b.getAttribute('data-group');
          root.querySelectorAll('[data-group]').forEach((x) => x.classList.toggle('is-active', x === b));
          const vf = $('#sc-version-field');
          const mf = $('#sc-manual-field');
          if (vf) vf.hidden = form.group === 'manual';
          if (mf) mf.hidden = form.group !== 'manual';
          fillVersions(root, form);
        });
      });

      sync();
      loadVersionData(root, form);
    },
  });

  if (result !== 'ok') return null;

  const mcVersion = String(form.manual || form.version || '').trim();
  if (!mcVersion) {
    toast('请先选一个版本（或切到「手动填」填版本号）', 'error', 3500);
    return null;
  }
  const r = await call('server:create', {
    name: form.name.trim() || ('服务端 ' + mcVersion),
    kind: form.kind,
    mcVersion,
  });
  const d = r && r.ok ? r.data : null;
  if (!d || !d.ok) {
    toast('创建失败：' + ((d && d.error) || (r && r.error) || '未知错误'), 'error', 6000);
    return null;
  }
  await loadServers();
  drawSidebar();
  view.currentId = d.server.id;
  await selectServer(d.server.id);
  toast('已创建，接着点「下载服务端」把 jar 拉下来', 'ok', 6000);
  return d.server.id;
}

/** 后台加载版本数据（不阻塞对话框） */
async function loadVersionData(root, form) {
  if (createData.loading) return;
  createData.loading = true;
  try {
    const jobs = [];

    // ① Mojang 正式版 + 快照
    if (!createData.releases || !createData.snapshots) {
      jobs.push(
        call('versions:manifest', {}, { optional: true }).then((r) => {
          const d = r && r.ok ? r.data : null;
          const all = (d && d.versions) || [];
          if (!all.length) return;
          createData.releases = all.filter((v) => v.type === 'release').map((v) => v.id);
          createData.snapshots = all.filter((v) => v.type === 'snapshot').map((v) => v.id);
        })
      );
    }

    // ② Betacraft 归档（远古版 + 官方已删除的周快照）
    if (!createData.ancient) {
      jobs.push(
        call('server:archive', {}, { optional: true }).then((r) => {
          const d = r && r.ok ? r.data : null;
          const groups = (d && d.groups) || [];
          if (!groups.length) return;
          const anc = groups.find((g) => g.id === 'ancient');
          createData.ancient = anc ? anc.items.map((i) => i.version) : [];
          const snap = groups.find((g) => g.id === 'snapshot');
          if (snap && snap.items) {
            const extra = snap.items.map((i) => i.version);
            const merged = new Set((createData.snapshots || []).concat(extra));
            createData.snapshots = Array.from(merged);
          }
        })
      );
    }

    // ③ 内置远古服务端
    if (!createData.builtin) {
      jobs.push(
        call('server:options', {}, { optional: true }).then((r) => {
          const d = r && r.ok ? r.data : null;
          createData.builtin = (d && d.builtin) || [];
        })
      );
    }

    await Promise.all(jobs);
    createData.loadedAt = Date.now();
    if (root && root.isConnected !== false) fillVersions(root, form);
  } finally {
    createData.loading = false;
  }
}

/** 按当前分组填充版本下拉框 */
function fillVersions(root, form) {
  if (!root || !root.querySelector) return;
  const sel = root.querySelector('#sc-version');
  const hint = root.querySelector('#sc-version-hint');
  const builtinField = root.querySelector('#sc-builtin-field');
  const builtinHint = root.querySelector('#sc-builtin-hint');
  if (!sel) return;

  let list = [];
  let note = '';

  if (form.group === 'release') {
    list = createData.releases || [];
    note = list.length ? ('共 ' + list.length + ' 个正式版') : '正在加载官方版本清单…（也可以切到「手动填」直接填）';
  } else if (form.group === 'snapshot') {
    list = createData.snapshots || [];
    note = list.length
      ? ('共 ' + list.length + ' 个快照（含官方已删除、Betacraft 归档保留的）')
      : '正在加载快照清单…';
  } else if (form.group === 'ancient') {
    list = createData.ancient || [];
    note = list.length
      ? ('共 ' + list.length + ' 个远古版本（Classic / Alpha / Beta / Infdev）')
      : '正在加载 Betacraft 归档清单…（也可以切到「手动填」写 b1.7.3）';
  } else {
    list = [];
    note = '直接填版本号，官方已下架的会自动从归档找';
  }

  if (form.kind !== 'vanilla' && list.length) {
    if (form.group === 'ancient') {
      note += ' · 注意：' + kindLabelOf(form.kind) + ' 不提供远古版本服务端，会按原版开';
    } else if (form.group === 'snapshot') {
      note += ' · 注意：' + kindLabelOf(form.kind) + ' 对快照的支持以它自己的版本清单为准';
    }
  }

  if (list.length) {
    const prev = sel.value;
    sel.innerHTML = list.map((v) => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');
    if (prev && list.indexOf(prev) >= 0) sel.value = prev;
    if (!sel.value) sel.value = list[0];
    form.version = sel.value;
  } else if (form.group !== 'manual') {
    sel.innerHTML = '<option value="">（暂无数据，可切到「手动填」）</option>';
  }

  if (hint) hint.textContent = note;

  if (builtinField && builtinHint) {
    const bs = (createData.builtin || []).filter((x) => x.exists);
    if (form.group === 'ancient' && bs.length) {
      builtinField.hidden = false;
      builtinHint.innerHTML = bs
        .map(function (x) {
          return '· <strong>' + esc(x.label) + '</strong>：可开 ' + x.covers.length + ' 个版本 —— ' + esc(x.desc || '');
        })
        .join('<br />');
    } else {
      builtinField.hidden = true;
    }
  }
}
'''

new_lines = lines[:start] + NEW.rstrip("\n").split("\n") + lines[end + 1:]
out = "\n".join(new_lines)
io.open(PATH, "w", encoding="utf-8", newline="\n").write(out)
print("已写入，新行数：%d" % len(new_lines))
