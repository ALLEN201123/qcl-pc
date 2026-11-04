# QCL 电脑版 · 远古版本中文补丁（Chinese Pack）实现说明

> 照搬安卓版 `LegacyChinesePack.java`（976 行）。本文件记录移植到 PC 版后的实现与**踩过的坑**。

---

## 为什么需要它

Beta 1.7.3 这类远古版本的字体是**固定 256 个 ASCII 字模**，一个汉字都没有 —— 不换字体，中文全是方框/乱码。界面文本也硬编码在 lang 文件里，换文件就是换语言。

安卓版为此做了 77 组补丁（`assets/cn_*`，共 119 个 jar / 13.2MB），逐版本对应不同的**混淆类名**。

---

## 补丁包含什么（以 b1.7.3 为例，`src/main/core/data/cn_b173/`，236 个文件 / 1.01MB）

| 文件 | 作用 |
|---|---|
| `sj.class` | 打过补丁的 FontRenderer（字模上限 **256 → 4096**） |
| `co.class` | 配套类 |
| `QclLangScreen.class` | 语言选择界面 |
| `font.txt` | 允许显示的字符表（原版 144 + 中文标点/常用字，共 **4359 字符**） |
| `font/glyph_XX.png` | Mojang 官方中文点阵，**222 张**（16×16 字形，屏幕上只画 8px，与英文等高） |
| `font/glyph_sizes.bin` | 字宽表 |
| `lang/zh_CN.lang` | 中文界面文本（30.9KB / 898 行） |
| `lang/en_US_orig.lang` | 原版英文（保留，供切回英文） |
| `lang_over/over_b18.lang` | 语言叠加（b1.6/b1.8 的界面文本与 b1.7.3 有差异） |
| `title/splashes.txt` | 标题界面闪烁标语（中文） |

## 注入流程

```
1. 备份原版：<版本>.jar → <版本>.jar.orig（首次注入时）
2. 读原 jar 的条目表
3. 逐条复制，跳过：
     · 本版本自己的 FontRenderer（如 b1.7.3 的 sj.class）
     · 本包额外注入的类（co.class / QclLangScreen.class）
     · 字体资源（font.txt / font/glyph_*.png / font/glyph_sizes.bin）
     · lang 文件与 splashes.txt
4. ★ 丢弃 META-INF 下的签名文件（*.SF / *.DSA / *.RSA）
5. ★ 清理 META-INF/MANIFEST.MF 里的逐条目摘要（只保留主属性段）
6. 写入补丁文件 → 输出到 .cnpatch 临时文件 → 原子 rename 替换原 jar
7. 写标记文件 .cnpack_lang（记着已按哪种语言打过补丁，避免重复注入）
```

---

## ⚠️ 两个必须知道的坑（都实际踩过）

### 坑 1：Mojang 签名校验 —— 不处理游戏直接崩

第一次注入后启动，立刻报：

```
java.lang.SecurityException: SHA1 digest error for lang/en_US.lang
    at sun.security.util.ManifestEntryVerifier.verify(ManifestEntryVerifier.java:223)
    at java.util.jar.JarVerifier.processEntry(JarVerifier.java:243)
    at net.minecraft.client.Minecraft.<init>(SourceFile:233)
```

**原因**：原版 jar 带 Mojang 数字签名（`META-INF/MOJANG_C.SF` + `MOJANG_C.DSA`），每个条目在 `MANIFEST.MF` 里都有 SHA1 摘要。我们替换了 `lang/en_US.lang`，摘要对不上，JVM 的 `JarVerifier` 就抛异常 —— 游戏连主界面都进不去。

**修法**（`chinesepack.js` 的 `isSignatureFile` / `stripManifestEntries`）：
1. 重建 jar 时丢掉 `META-INF/*.SF` / `*.RSA` / `*.DSA`；
2. 把 `MANIFEST.MF` 里所有「逐条目摘要段」清掉，只保留主属性（`Manifest-Version` / `Main-Class` 这些不影响校验）。

安卓版不需要这一步，因为它走的是 JVM 宽松模式 / 不同的校验路径；PC 上必须做。

### 坑 2：同名类不等于同一个东西

`sj.class` 在 **b1.7.3** 里是 FontRenderer，但在 **b1.6 / b1.8 / 1.0** 里是完全不同的类。如果按「见 sj 就跳过」处理，那些版本会崩。

安卓版注释里记着一次真实事故：`in-20100223` 点「载入世界」直接
`ArrayIndexOutOfBoundsException: 36733 at net.minecraft.client.c.j.a` ——
原因就是给不该注入的版本塞了别人的补丁类。

**安全规则**：
- 只在「当前版本对应的补丁包」激活时，才跳过它自己那个 FontRenderer；
- 其余类名**一个都不许动**；
- 判断依据是**版本名正则**（`PACKS[].match`），不是类名。

---

## 语言切换

- 默认 **简体中文**（`LANG_ZH = 'zh_CN'`）
- 切回英文：`chinesepack.switchLanguage({ versionDir, versionId, lang: 'en_US' })`
- 中文模式下会把中文文本**同时写成 `lang/en_US.lang`** —— 因为远古版本没有语言选择界面，游戏永远读 `en_US.lang`，不这么做中文不会生效。
- 原版英文保留在 `lang/en_US_orig.lang`，随时可还原。

## 当前支持范围

**第一版只做 b1.7.3**（`PACKS` 里一条规则），验证机制跑通后再按 `LegacyChinesePack.java` 里的
`EXTRA_PACKS` / `B19_PACKS` 表逐批铺开（那两张表有 70+ 条规则，覆盖 alpha/beta/1.0/infdev/indev 全系）。

扩展方式：把对应 `cn_*` 目录复制到 `src/main/core/data/`，在 `PACKS` 里加一条 `{ match, dir, fontRenderer, extraClasses, skipEntries }` 即可。

## 验收结果（实测）

```
node build\verify-chinesepack.js b1.7.3
   ✅ 字体类 sj.class 存在
   ✅ glyph 点阵齐全 — 222 张
   ✅ font.txt 已注入
   ✅ glyph_sizes.bin 已注入
   ✅ lang/zh_CN.lang 已注入
   ✅ lang/en_US.lang 已注入（中文内容）
   ✅ 标题标语已注入
   ✅ 标记文件已写 — appliedLang=zh_CN
   ✅ 原版类一个没丢 — 746 个都在
   ✅ 无重复条目
   ✅ lang/en_US.lang 含中文（游戏读的就是它）
   ✅ 原版备份 .jar.orig 已创建
   ════════ 结果：12/12 通过 ════════
```

**游戏内实证**（b1.7.3 主界面截图）：`单人游戏` / `多人游戏` / `模组与材质包` / `选项` / `退出游戏` 全部正常显示，标题标语「绝对没有桶」—— 中文渲染完全正确。
