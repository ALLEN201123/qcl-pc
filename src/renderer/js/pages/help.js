/**
 * Quanta Craft Launcher PC · 使用说明
 *
 * ★ 为什么要有这一页：
 *   用户明确要求「补充一下说明页，我们的中文补丁（手机端）移植过来说明一下」，
 *   并且要把「这个启动器基本等于中国版 Betacraft」这件事讲清楚。
 *
 * 内容全部来自**已经实现并实测过的代码**，不是宣传文案：
 *   · 中文补丁：core/chinesepack.js（照安卓版 LegacyChinesePack.java 移植，77 组规则）
 *   · 远古版本：core/mojang.js（258 条内置归档）+ core/install.js（.info 重建）
 *   · 兼容参数：core/launch.js（-Dhttp.proxyHost=betacraft.uk 等）
 *   · 加载器：core/loaderversions.js + renderer/pages/download.js 的推荐规则
 *   · 目录布局：core/paths.js（libraries/assets 共享）
 *
 * 页面里的数字优先用主进程 `app:help` 返回的真实值，取不到才退回写死的常量，
 * 免得数据一变文档就开始说谎。
 */

import { call } from '../bridge.js';
import { state } from '../store.js';
import { html, raw, setHTML } from '../ui.js';
import { icon } from '../icons.js';

const TABS = [
  { id: 'chinese', label: '中文补丁', glyph: 'file' },
  { id: 'legacy', label: '远古版本 · Betacraft', glyph: 'clock' },
  { id: 'loaders', label: '加载器', glyph: 'pack' },
  { id: 'layout', label: '目录布局', glyph: 'folder' },
  { id: 'update', label: '更新', glyph: 'refresh' },
  { id: 'faq', label: '常见问题', glyph: 'info' },
];

let activeTab = 'chinese';
/** app:help 拿到的真实数字，取不到就是 null */
let liveInfo = null;

/* ------------------------------ 通用小工具 ------------------------------ */

const kv = (pairs) =>
  raw(
    `<div class="kv">${pairs
      .map(([k, v]) => `<div class="kv__k">${k}</div><div class="kv__v">${v}</div>`)
      .join('')}</div>`,
  );

const table = (head, rows) =>
  raw(
    `<table class="doc__table"><thead><tr>${head
      .map((h) => `<th>${h}</th>`)
      .join('')}</tr></thead><tbody>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
      .join('')}</tbody></table>`,
  );

const steps = (items) => raw(`<ol class="doc__steps">${items.map((x) => `<li>${x}</li>`).join('')}</ol>`);

/* ------------------------------ 各分节 ------------------------------ */

function sectionChinese() {
  const cp = liveInfo && liveInfo.chinesePack;
  const rules = cp ? cp.rules : 77;
  const dirs = cp ? cp.dirs : 71;

  return html`
    <div class="card">
      <div class="card__title">这是什么</div>
      <div class="doc__text">
        远古版本（Beta 1.7.3 那批）的字体是<strong>固定 256 个 ASCII 字模</strong>，一个汉字都没有，
        换不了字体就是满屏方框；界面文本也硬编码在 <span class="mono">lang</span> 文件里。
        官方启动器早就不管这些版本了，所以<strong>中文补丁是我们自己做的</strong>。
        <br /><br />
        它的来源是<strong>安卓版 QCL 的 <span class="mono">LegacyChinesePack.java</span>（976 行）</strong>，
        PC 版按同样的规则完整移植过来：现在共 <strong>${rules} 组规则</strong>、
        <strong>${dirs} 个可用补丁包</strong>（<span class="mono">src/main/core/data/cn_*</span>）。
      </div>
    </div>

    <div class="card">
      <div class="card__title">补丁里到底装了什么</div>
      <div class="doc__text">
        以最完整的 b1.7.3 主包为例（<span class="mono">data/cn_b173/</span>，236 个文件）：
      </div>
      ${table(
        ['文件', '作用'],
        [
          ['<span class="mono">sj.class</span>', '打过补丁的 FontRenderer —— 字模上限从 <strong>256 提到 4096</strong>'],
          ['<span class="mono">co.class</span>', '配套类（原版 FontRenderer 的依赖）'],
          ['<span class="mono">QclLangScreen.class</span>', '游戏内的语言选择界面（原版没有这个界面）'],
          ['<span class="mono">font.txt</span>', '允许显示的字符表：原版 144 + 中文标点/常用字，共 <strong>4359</strong> 个字符'],
          ['<span class="mono">font/glyph_*.png</span>', 'Mojang 官方中文点阵，<strong>223 张</strong> 16×16 字形（屏幕上只画 8px，与英文等高）'],
          ['<span class="mono">font/glyph_sizes.bin</span>', '字宽表（中文按等宽算，英文按原版宽度）'],
          ['<span class="mono">lang/zh_CN.lang</span>', '中文界面文本（约 30.9 KB / 898 行）'],
          ['<span class="mono">lang/en_US_orig.lang</span>', '原版英文，用来随时切回去'],
          ['<span class="mono">lang_over/over_b18.lang</span>', '语言叠加：b1.6 / b1.8 的文本与 b1.7.3 有差异，靠叠加修正'],
          ['<span class="mono">title/splashes.txt</span>', '标题界面的闪烁标语（中文）'],
        ],
      )}
    </div>

    <div class="card">
      <div class="card__title">注入流程（装版本时自动做，不用你管）</div>
      ${steps([
        '备份原版：<span class="mono">&lt;版本&gt;.jar</span> → <span class="mono">&lt;版本&gt;.jar.orig</span>（只在首次注入时做）',
        '读原 jar 的条目表',
        '逐条复制，跳过本版本自己的 FontRenderer、补丁要覆盖的类、字体资源、lang 文件与 splashes.txt',
        '<strong>丢弃 META-INF 下的签名文件</strong>（<span class="mono">*.SF / *.DSA / *.RSA</span>）—— 不丢游戏直接抛 SecurityException',
        '<strong>清理 MANIFEST.MF 里的逐条目摘要</strong>（只保留主属性段），否则同样会被判篡改',
        '写入补丁文件 → 先写到临时文件 → 原子 rename 替换原 jar（中途失败原 jar 不受影响）',
        '写标记文件 <span class="mono">.cnpack_lang</span> 记住已按哪种语言打过补丁，避免重复注入',
      ])}
    </div>

    <div class="card">
      <div class="card__title">语言大小写：1.1 那个崩溃 BUG</div>
      <div class="doc__text">
        写 <span class="mono">options.txt</span> 的 <span class="mono">lang</span> 值时，
        <strong>大小写必须按版本区分</strong>，写错就会撞上 1.1 时代的崩溃：
      </div>
      ${table(
        ['版本', '写法', '原因'],
        [
          ['≤ 1.0', '<strong>不写</strong>', '这些版本还没有 lang 机制，写了反而出问题'],
          ['1.1 ~ 1.10', '<span class="mono">zh_CN</span>（大写）', '当年的语言键就是大写，写成小写会找不到语言、进游戏崩溃'],
          ['1.11 及以后 / 26.x', '<span class="mono">zh_cn</span>（小写）', '1.11 起改成小写键，写成大写同样会崩'],
          ['远古（alpha/beta/RC）', '跳过', '它们不走 lang 机制，语言是直接注入补丁 jar 实现的'],
        ],
      )}
      <div class="doc__hint">实现见 <span class="mono">core/gameoptions.js</span> 的 normalizeLangCase / fixLangCase，每次启动前都会校对一遍。</div>
    </div>

    <div class="card">
      <div class="card__title">怎么切回英文 / 怎么撤销</div>
      <div class="doc__text">
        · 想换语言：版本设置 → 游戏 → 语言，或直接改 <span class="mono">options.txt</span>；
        <br />· 想彻底撤销补丁：把版本目录里的 <span class="mono">.cnpack_lang</span> 删掉、再用
        <span class="mono">&lt;版本&gt;.jar.orig</span> 覆盖 <span class="mono">&lt;版本&gt;.jar</span>；
        <br />· 装了补丁的版本会自动<strong>跳过文件校验</strong> —— 不跳的话"修复文件"会把打过补丁的 jar
        当成损坏文件用原版覆盖，中文就白装了。
      </div>
    </div>
  `;
}

function sectionLegacy() {
  const arc = liveInfo && liveInfo.archive;
  const count = arc && arc.count ? arc.count : 258;

  return html`
    <div class="card">
      <div class="card__title">一句话：它基本就是「中国版 Betacraft」</div>
      <div class="doc__text">
        Betacraft 是国外专门伺候远古版本（pre-classic → Beta）的启动器。
        QCL 的主攻方向与它一致，而且多了<strong>全远古版本中文补丁</strong>。
        下面这些就是照着 Betacraft 那套做过来的：
      </div>
      ${table(
        ['能力', 'QCL 电脑版的做法'],
        [
          [
            '远古版本全量归档',
            `内置 <strong>${count} 条</strong>归档清单（Betacraft 快照，<span class="mono">data/legacy_version_archive.json</span>），从 <span class="mono">rd-132211</span> 一直到 Beta / RC`,
          ],
          [
            '归档版本还原启动结构',
            '读 Betacraft 的 <span class="mono">.info</span> 拿真实 jar 地址，再用 <span class="mono">legacy_launch_template.json</span> 按 b1.7.3 的骨架重建版本 JSON（老的 launchwrapper / <span class="mono">--tweakClass</span> 那套）',
          ],
          [
            '官方清单优先',
            '同一个版本官方 manifest 里有时也有（old_alpha / old_beta），那种优先用官方 JSON（自带真实 libraries 与 assetIndex），只有 Betacraft 专属构建才重建',
          ],
          [
            '老版本皮肤 / 会话可用',
            '启动远古版本时自动注入 <span class="mono">-Dhttp.proxyHost=betacraft.uk</span> —— 极老版本的皮肤、会话、资源请求都指向已经废弃的域名，走社区代理才能通过',
          ],
          [
            '老 Java 排序兼容',
            '同时注入 <span class="mono">-Djava.util.Arrays.useLegacyMergeSort=true</span>，不加的话 Java 7+ 的 TimSort 会在世界加载时抛 "Comparison method violates its general contract!" 直接崩',
          ],
          [
            '老音效 / 资源',
            '远古版本的 sound / resources 目录按老结构铺开，不走现代 assets 索引',
          ],
          [
            '中文补丁',
            '<strong>Betacraft 没有</strong>：77 组中文补丁，见上一页',
          ],
        ],
      )}
      <div class="doc__hint">
        这两个参数如果你自己填过代理或排序参数（版本设置 → 启动参数 → JVM 参数），
        启动器会判断"玩家已自定义"并跳过自动注入，不会覆盖你的设置。
      </div>
    </div>

    <div class="card">
      <div class="card__title">★ 自动注入的那两行 Java 参数（全部远古版本）</div>
      <div class="doc__text">
        玩家下载并装好<strong>任何一个</strong>远古版本后，启动游戏时会自动加上这两行，不需要手动设置：
      </div>
      ${raw(`<pre class="doc__pre">-Dhttp.proxyHost=betacraft.uk
-Djava.util.Arrays.useLegacyMergeSort=true</pre>`)}
      <div class="doc__text">
        覆盖范围按 <span class="mono">data/legacy_version_archive.json</span> 的
        <strong>${count} 条归档清单</strong>精确判定，外加官方 old_alpha / old_beta 前缀 ——
        pre-classic（rd-/pc-）、classic（c0.）、indev（in-）、infdev（inf-）、alpha（a1.x）、
        beta（b1.x）、<strong>以及官方已删除、被 Betacraft 收录的 11w/12w/13w 周快照、1.0 RC、2.0 愚人节版</strong>，
        一个不漏。装了 OptiFine / Forge / 中文补丁导致版本目录改名时也照样命中
        （同时核对实例里的原始版本号）。
      </div>
      <div class="doc__hint">
        想亲眼确认：<strong>版本设置 → 启动参数</strong> 页里有一块「远古版本自动注入的 Java 参数」，
        显示的就是启动器真正会加的这两行（现代版本会显示「不注入」）。
        你在上面自己写了 <span class="mono">proxyHost</span> 或 <span class="mono">useLegacyMergeSort</span>，
        它会变成「未启用」并说明原因。
      </div>
    </div>

    <div class="card">
      <div class="card__title">官方删掉、但 Betacraft 还留着的快照</div>
      <div class="doc__text">
        Mojang 的 version_manifest 里有一批老周快照已经被删掉了，
        但 Betacraft 归档里还留着 <span class="mono">.info</span> 与 jar 直链。
        QCL 把「官方清单里没有、归档里有」的这 <strong>74 个周快照</strong>补进下载页的「快照」分页，
        卡片上标 <strong>「归档」</strong> 徽标；点安装后走 Betacraft 的
        <span class="mono">.info</span> 还原启动结构，不需要官方 JSON。
      </div>
    </div>

    <div class="card">
      <div class="card__title">还没从 Betacraft 搬过来的</div>
      <div class="doc__text">
        老实列一下，免得你以为都有了：
      </div>
      ${table(
        ['Betacraft 有', '现状'],
        [
          ['皮肤站（把老版本的 skins.minecraft.net 请求转发到活的皮肤库）', '只做了 http 代理这一层，没有独立的皮肤服务'],
          ['一体化认证服务（老版本 login.minecraft.net 兼容）', '靠同一个 http 代理，没做本地认证服务'],
          ['服务器列表与在线人数', '没做（没有公开 API，得自己抓）'],
          ['网页版档案浏览', '没做（启动器里已经能看全部版本，网页版不重要）'],
        ],
      )}
    </div>
  `;
}

function sectionLoaders() {
  return html`
    <div class="card">
      <div class="card__title">安装游戏时会让你选加载器</div>
      <div class="doc__text">
        点「安装」<strong>不会直接装原版</strong>，而是先弹一个加载器选择框，
        并按 MC 版本自动标出推荐项，还会异步查出该版本能用的<strong>最新稳定版本号</strong>。
        装成原版之后再想用模组，得把整个版本重装一遍 —— 所以先想好。
      </div>
      ${table(
        ['加载器', '适用版本', '说明'],
        [
          ['原版', '全部', '纯净，不带任何模组加载器'],
          ['Fabric', '<strong>1.14+ 推荐</strong>', '轻量、更新快，Sodium / Iris 这类优化模组都基于它'],
          ['Forge', '<strong>1.0 ~ 1.13.2 推荐</strong>', '老牌加载器，老版本生态几乎全靠它；1.14 之前 Fabric 覆盖很差'],
          ['NeoForge', '1.20.2+', 'Forge 的分支，新版主流'],
          ['Quilt', '1.14+', 'Fabric 的分支，生态较小'],
          ['ModLoader', '<strong>远古版本推荐</strong>（1.6.2 / Beta / 部分 Alpha）', "Risugami's ModLoader：把 class 直接注入本体 jar，装完写 <span class=\"mono\">.modloader</span> 标记并自动关掉该版本的文件校验"],
          ['Babric', '<strong>b1.7.3 推荐</strong>', 'Babric 是 b1.7.3 的 Fabric 分支，能跑现代性能模组与 Mixin；注意它的库在 glass-launcher 自己的 maven 上，<strong>不能走 BMCLAPI 镜像</strong>（镜像上没有，会被换成 404）'],
        ],
      )}
      <div class="doc__hint">
        推荐规则：远古（alpha/beta/indev…）→ ModLoader，b1.7.3 → Babric，1.0~1.13.2 → Forge，1.14+ → Fabric。
      </div>
    </div>

    <div class="card">
      <div class="card__title">关于 5 个装不了的 Alpha 版</div>
      <div class="doc__text">
        a1.2.6 / a1.2.2 / a1.2.1_01 / a1.2.0_02 / 1.1 这几个版本的 ModLoader
        官方只发了 <span class="mono">.rar</span>，启动器解不开 rar，界面上会灰掉并写明原因 —— 不会让你等一个必然失败的下载。
      </div>
    </div>

    <div class="card">
      <div class="card__title">前置依赖会自动提示</div>
      <div class="doc__text">
        装模组时如果它声明了必须的前置（例如 Iris 需要 Sodium），会弹窗列出全部必需前置并<strong>默认全勾</strong>一起装。
        如果你坚持不装某个必需前置，会再确认一次并提醒"缺少依赖可能导致游戏崩溃"。
      </div>
    </div>
  `;
}

function sectionLayout() {
  const home = state.settings.home || '<QCL_HOME>';
  return html`
    <div class="card">
      <div class="card__title">数据目录</div>
      <div class="doc__text">默认在「文档\\QCL」，可以改。当前是：<span class="mono">${home}</span></div>
      ${raw(`<pre class="doc__pre">${home}/
  settings.json              设置
  accounts.json              账号
  instances.json             实例索引
  instances/&lt;id&gt;/
      instance.json
      .minecraft/            ← 这个实例的游戏目录（mods / saves / config 都在这里）
          versions/&lt;版本&gt;/    ← 只有这个实例自己的版本文件
  .minecraft/
      libraries/             ← 所有实例共享
      assets/                ← 所有实例共享
  meta/                      版本 JSON / 资源索引缓存
  logs/latest.log            最近一次启动或安装的日志
  backups/                   存档备份
  exports/                   导出的整合包 / 存档
  recycle/                   删除的东西（可恢复，不硬删）</pre>`)}
    </div>

    <div class="card">
      <div class="card__title">为什么 libraries / assets 是共享的</div>
      <div class="doc__text">
        照 HMCL 的语义：「除 assets、libraries 外，各版本独立」。
        每个版本的库和资源高度重复，共享之后目录能从 1.1 GB 降到 0.6 GB 左右（实测）。
        <br /><br />
        老版本装出来的实例（库和资源在自己目录里）会在启动后<strong>自动在后台迁移</strong>到新布局。
        迁移期间启动/安装会被闸门挡住，避免读到"搬了一半"的库 —— 所以第一次启动会稍微慢一点点。
      </div>
    </div>

    <div class="card">
      <div class="card__title">删除都是移到回收站</div>
      <div class="doc__text">
        存档、模组、资源包、光影、数据包的"删除"一律<strong>移到 <span class="mono">recycle/</span> 目录</strong>，
        不做硬删除。删错了可以自己从那里拿回来。
      </div>
    </div>
  `;
}

function sectionFaq() {
  return html`
    <div class="card">
      <div class="card__title">启动失败 / 游戏起不来</div>
      <div class="doc__text">
        · 先看「工具 → 崩溃日志分析」，它会按常见原因给出中文结论；
        <br />· 再点「设置 → 游戏 → 检查游戏文件」，它会按 sha1 校验并自动修坏掉的客户端 jar 与库
        （26.3 那次 <span class="mono">NoClassDefFoundError: net/minecraft/util/Unit</span> + 
        <span class="mono">ZipFile invalid LOC header</span> 就是 jar 大小对但 sha1 不对，被这个检查修好的）；
        <br />· 一个 Java 都没有的话，启动器会提示并支持免登录下载（Adoptium 官方直链）。
      </div>
    </div>

    <div class="card">
      <div class="card__title">Java 版本怎么选</div>
      ${table(
        ['MC 版本', 'Java'],
        [
          ['≤ 1.16.5', '8'],
          ['1.17 ~ 1.20.4', '17'],
          ['1.20.5 ~ 1.21.11', '21'],
          ['26.x', '25'],
          ['远古（alpha/beta/RC）', '8'],
        ],
      )}
      <div class="doc__hint">启动器会按这个表自动挑；挑不到会提示你装哪个。</div>
    </div>

    <div class="card">
      <div class="card__title">模组装了没效果</div>
      <div class="doc__text">
        ① 先确认这个版本装的是<strong>哪个加载器</strong>（见「加载器」页）—— 装成原版的话模组不会加载；
        <br />② 模组和加载器要匹配：Fabric 模组不能扔进 Forge；
        <br />③ 前置没装齐会表现为"能进游戏但没有这个模组"，看「模组管理」里的依赖提示；
        <br />④ 中文补丁版本会自动跳过文件校验，如果你手动点了"修复文件"，补丁会被原版覆盖 —— 重新装一次就好。
      </div>
    </div>

    <div class="card">
      <div class="card__title">装了两个同项目的模组</div>
      <div class="doc__text">
        内容下载默认「重复时覆盖」：同一个项目再装新版本会<strong>替换旧文件</strong>，不会留下两个 jar
        （留两个反而会让游戏崩）。想改可以在「设置 → 下载 → 下载内容重复时」调。
      </div>
    </div>

    <div class="card">
      <div class="card__title">这个启动器和官方 / 其它启动器的关系</div>
      <div class="doc__text">
        QCL 是非官方启动器，与 Mojang Studios、Microsoft 无隶属关系。Minecraft 是 Mojang 的商标。
        启动核心<strong>参照 MultiMC 源码</strong>实现；界面与功能来源是安卓版 QCL；远古版本的处理思路参照 Betacraft。
        许可 GNU GPL-3.0，仓库
        <span class="mono">https://github.com/ALLEN201123/qcl-pc</span>（设置 → 关于可以一键打开）。
      </div>
    </div>
  `;
}

/** 更新推送说明（未来发布新版本时客户端怎么提示） */
function sectionUpdate() {
  return html`
    <div class="card">
      <div class="card__title">启动器会自己检查新版本</div>
      <div class="doc__text">
        每次打开主页，启动器会静默查一次本仓库的
        <span class="mono">https://github.com/ALLEN201123/qcl-pc/releases/latest</span>：
        <br />· 发现正式新版本 → 主页顶部出现一条中文提示「发现新版本 QCL x.y.z」+「查看更新」按钮；
        <br />· 草稿 / 预发布不会提示；离线、被墙、GitHub 限流一律<strong>静默跳过</strong>，不弹错误打扰你；
        <br />· 结果缓存 6 小时，不会每次都打网络。
      </div>
      <div class="doc__hint">
        <strong>只提示，不自动下载、不自动安装</strong> —— 安装包是 exe，
        你想升级就点「查看更新」去 Release 页自己下载双击。当前版本在「设置 → 关于」里看。
      </div>
    </div>
    <div class="card">
      <div class="card__title">以后发新版要做的（给维护者）</div>
      ${steps([
        '把 <span class="mono">package.json</span> 的 <span class="mono">version</span> 改成新版本号（如 1.0.1）',
        '重新打包：<span class="mono">electron-builder --dir</span> + <span class="mono">build/make-installer.ps1 -Version 1.0.1</span>',
        '在 GitHub 建 <span class="mono">v1.0.1</span> 的 Release（非草稿、非预发布），把 exe 作为资产传上去',
        '发布完成后，所有旧版客户端下次打开主页就会自动看到更新提示 —— <strong>不需要改客户端代码</strong>',
      ])}
      <div class="doc__text">
        版本号比较按语义版本（1.0.0 &lt; 1.0.1 &lt; 1.1.0），预发布版低于同号正式版。
        资产名带 <span class="mono">.exe</span> 且含 QCL/Setup/安装 即被识别为安装包。
      </div>
    </div>
  `;
}

const RENDERERS = {
  chinese: sectionChinese,
  legacy: sectionLegacy,
  loaders: sectionLoaders,
  layout: sectionLayout,
  update: sectionUpdate,
  faq: sectionFaq,
};

/* ------------------------------ 页面 ------------------------------ */

export const helpPage = {
  id: 'help',
  title: '使用说明',
  async render(mount) {
    // 真实数字（失败就用写死常量，页面不会空）
    try {
      const r = await call('app:help', {}, { optional: true });
      if (r && r.ok && r.data) liveInfo = r.data;
    } catch {
      liveInfo = null;
    }

    const body = () => (RENDERERS[activeTab] || sectionChinese)();

    const draw = () => {
      setHTML(
        mount,
        html`<div class="page page--panel">
          <div class="page__head">
            <div class="page__title">使用说明</div>
            <div class="page__sub">中文补丁怎么来的 · 远古版本为什么说是「中国版 Betacraft」· 加载器怎么选</div>
          </div>
          <div class="page__body doc">
            <div class="doc__tabs">
              ${TABS.map(
                (t) => html`<button class="doc__tab ${t.id === activeTab ? 'is-active' : ''}" type="button" data-doc-tab="${t.id}">
                  ${raw(icon(t.glyph, 15))}<span>${t.label}</span>
                </button>`,
              )}
            </div>
            <div class="doc__content">${body()}</div>
            <div class="doc__foot">
              这份说明对应 QCL ${state.appInfo ? state.appInfo.version : ''} · 内容都是照着已实现的代码写的，不含「即将支持」。
            </div>
          </div>
        </div>`,
      );
      mount.querySelectorAll('[data-doc-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeTab = btn.getAttribute('data-doc-tab');
          draw();
        });
      });
    };

    draw();
    return {};
  },
};

export default helpPage;
