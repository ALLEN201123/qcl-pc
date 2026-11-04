# QCL 主界面 3D 人物渲染 · 移植规格书（从安卓版 1.5.9 彻底移植）

> 来源：`D:\QCL-build\QCL\src\main\java\com\qcl\launcher\skin\gltf\`
> `SkinRenderer.kt`(396) · `GltfModel.kt`(667) · `SolidSkinLayer.kt`(314) · `SkinViewer.kt`(310) · `SkinAnimations.kt`(59)
>
> **要求：不是"画一个像人的东西"，是把上面这套管线原样搬过来。**
> 之前用 canvas 2D / CSS 3D 拼的"塑料纸"一律作废 —— 那种做法没有 glTF 几何、没有法线光照、
> 没有实心层，做不出安卓版那种立体感。

---

## 1. 模型资源（照搬，不要自己建）

| 文件 | 用途 |
|---|---|
| `assets\img\skin_model\classic-player.gltf` | **经典（粗手臂 4px）** 玩家模型 |
| `assets\img\skin_model\slim-player.gltf` | **纤细（细手臂 3px）** 玩家模型 |
| `assets\img\steve.png` | 默认皮肤（经典） |
| `assets\img\alex.png` | 默认皮肤（纤细） |

复制到 `src/renderer/assets/skin_model/`。glTF 是**自包含**的（几何数据内嵌 buffer base64），
但 `images[0].uri = "steve.png"`、`images[1].uri = "cape"` 是**外部引用** ⇒ 把 `steve.png` 放到同目录，
`cape`（披风）**没有对应文件** ⇒ 加载后**隐藏 `Cape_2` 网格**，等真有披风贴图时再替换。

### 模型结构（已实测）

- **13 个网格**：`Head_2`、`Hat_Layer`、`Right_Arm_2`、`Right_Arm_Layer`、`Left_Arm_2`、`Left_Arm_Layer`、
  `Body_2`、`Body_Layer`、`Right_Leg_2`、`Right_Leg_Layer`、`Left_Leg_2`、`Left_Leg_Layer`、`Cape_2`
- **骨骼层级**：`RootNode → CINEMA_4D_Editor → blockbench_export → Node_18 → Orbit → {Body, Head, Right_Arm, Left_Arm, Cape, Right_Leg, Left_Leg}`
  （每个部位节点下挂 `*_2` 基础网格与 `*_Layer` 图层）
- **6 段动画**（节点旋转关键帧，**不是骨骼蒙皮**）：
  `CINEMA_4D_Main` · `idle` · `idle_sub_1` · `idle_sub_2` · `idle_sub_3` · `interact`
- **2 个材质**：都 `alphaMode:"BLEND"`、`doubleSided:false`、Lambert 着色模型、`baseColorTexture` 指向皮肤贴图

---

## 2. 渲染管线（三层，必须都做）

### 第 1 层 · 基础网格（`*_2`）
- **`uLightMix = 0` ⇒ 完全不做光照**，直接用贴图颜色（`GltfModel.kt:100`）。
- 基础网格的几何**没有法线属性**（`GltfModel.kt:105` 注释："基础网格无法线：法线属性禁用并给常量值"）。

### 第 2 层 · 实心层（`SolidSkinLayer`）
这是安卓版立体感的来源，**必须实现**：
- 按皮肤贴图逐像素判定：`(像素 >>> 24) >= 26` ⇒ 认为"实心"（**阈值就是 26，不是 255**）
  —— `SolidSkinLayer.kt:184-190` 与 `ALPHA_THRESHOLD = 26`（:348）。这里踩过坑：改成 `==255` 会让手臂半透明阴影整片消失、手臂缺一半。
- 把基础网格上"UV 落在实心像素上"的面片抽出来，生成一层，用 **`uLightMix = 1`** 渲染（`SolidSkinLayer.kt:119`）。
- 效果：不透明的主体有明暗立体感，半透明边缘保持原样。

### 第 3 层 · 图层（`*_Layer`：帽子层 / 身体外套层 / 臂层 / 腿层）
- 正常贴图采样，`alpha < 0.1` 丢弃（`discard`）。
- 混合为预乘 alpha。

---

## 3. 片元着色器（逐字照抄公式）

```glsl
// 顶点：vTexCoord = aTexCoord; vNormal = uNormalMatrix * aNormal;
uniform sampler2D uTexture;
uniform float uLightMix;      // 基础网格 0，实心层 1

vec4 color = texture2D(uTexture, vTexCoord);
if (color.a < 0.1) discard;
// 基础网格 lightMix=0 保持无光照观感
float light = mix(1.0, 0.70 + 0.42 * max(dot(normalize(vNormal), vec3(0.371, 0.743, 0.557)), 0.0), uLightMix);
gl_FragColor = vec4(color.rgb * light, color.a);
```

- **光方向常量**：`vec3(0.371, 0.743, 0.557)`
- **光照区间**：`0.70 ~ 1.12`（背光面 0.70，正对光 1.12）
- 注意这是**简单的半兰伯特**，没有镜面、没有环境色 —— 照抄即可，不要"美化"成 PBR。

### 状态
```
glEnable(GL_DEPTH_TEST); glDepthFunc(GL_LEQUAL);
glEnable(GL_BLEND); glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);   // 预乘 alpha
glClearColor(0, 0, 0, 0);                                          // 背景全透明
```
⇒ WebGL 里：`new WebGLRenderer({ alpha:true, premultipliedAlpha:true, antialias:true })`，
材质 `blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor`，
纹理上传前**预乘 alpha**（或让 GLTFLoader 处理后手动处理）。

---

## 4. 相机与交互（`SkinRenderer.kt` / `SkinViewer.kt`）

```
fov      = 50°
zoom     = 0.9
distance = 4.5 + 16.5 / tan(fov/2) / zoom / scale      // clamp 到 [10, 256]
scale    = 手势缩放，范围与旧版 0.7~2.0 等价
相机位置 = (0, 0, distance)，lookAt (0,0,0)，up = (0,1,0)   // 相机在 +Z 轴
外层旋转 = rotateX(rotationX) · rotateY(rotationY)          // 作用在模型 wrapper 上
```

**交互（照 SkinViewer）**：
- 拖拽：`rotationY += ROTATE_STEP * dx`、`rotationX += ROTATE_STEP * dy`（鼠标拖动即可，PC 上不需要双指）
- 滚轮：缩放 `scale`（对应 `setScale`，需 clamp）
- 双击（300ms 内两次）：`DOUBLE_TAP_INTERVAL = 300L`
- **帧循环 60fps**：`FRAME_INTERVAL_NANOS = 16_000_000`（用 `requestAnimationFrame` 即可）

---

## 5. 动画（`SkinAnimations.kt`）

- 注册表就 4 条：`idle`、`idle_sub_1`、`idle_sub_2`、`idle_sub_3`
- **默认播 `idle`**；变体规则照 FCL：`entries.drop(1).filter { it.id.startsWith("idle_sub") }` ⇒ `idle_sub_1/2/3`
- 未知 id 一律回退 `idle`
- 设置里可选动画（`SkinAnimations.restore/save`），默认 `idle`（旧版默认走路已废弃）
- `interact` 与 `CINEMA_4D_Main` 存在但不在选择表里（可留作后续"点击互动"用）

---

## 6. 皮肤贴图规则

- 用户皮肤（正版）：从皮肤服务拉 64×64 PNG；离线皮肤：本地设置
- **按皮肤宽度判定粗细手臂**：64×64 且第二层手臂宽度 3px ⇒ `slim-player.gltf`；否则 `classic-player.gltf`
- 没有皮肤时用默认：经典 → `steve.png`，纤细 → `alex.png`
- 贴图替换要**同时**作用于：基础网格材质、实心层材质、图层材质

---

## 7. 实现建议（Electron 端）

- 用 **three.js**（本地 `src/renderer/vendor/three/`，**不许 CDN**）：
  - `GLTFLoader` 负责几何/节点层级/6 段动画解析
  - `AnimationMixer` 播 `idle`，定时随机插播 `idle_sub_*`
  - 材质用 **自定义 `ShaderMaterial`** 精确复现第 3 节公式（**不要**用 `MeshLambertMaterial`，
    three 的光照有 PI 归一化和色调映射，出来的观感与安卓版不一致）
- **资源加载必须走自定义协议**（`qcl://app/...`），不能用 `file://` 直接 `fetch` ——
  Chromium 禁止 `file://` 下的 fetch/XHR（GLTFLoader 会加载失败）。主进程已注册该协议，
  所以写 `./assets/skin_model/classic-player.gltf` 这类相对路径即可，会解析到 `qcl://app/...`。
- 画布尺寸跟随容器（`ResizeObserver`），`devicePixelRatio` 上限 2，避免高分屏糊。

## 8. 验收（必须自己看过）

1. 主界面人物**有帽子层、有身体外套层**（不是光秃秃一层皮）；
2. 人物**在动**（idle 呼吸/摆臂），不是静止图片；
3. 不透明主体**有明暗**（能用肉眼看出光照方向：左上前方亮、右下暗），不是一整块纯色；
4. 皮肤里的**半透明像素仍然半透明**（手臂阴影不会消失、也不会变成实心块）；
5. 能拖拽旋转、能滚轮缩放；
6. 换皮肤（离线/默认 steve、alex）后模型与粗细手臂**跟着换**。
