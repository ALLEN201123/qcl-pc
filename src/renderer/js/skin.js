/**
 * QCL 电脑版 · 主界面 3D 人物（从安卓版 1.5.9 彻底移植）
 *
 * 见 `docs/SKIN_RENDERER_SPEC.md`。要点：
 *   · 模型是 Blockbench 导出的 glTF（classic-player.gltf 粗手臂 / slim-player.gltf 细手臂），
 *     **不是 canvas 画的**。
 *   · 三层渲染：基础网格（uLightMix=0，无光照）+ 实心层（uLightMix=1，有光照）+ 图层（帽子/外套）。
 *   · 实心层是关键：按贴图逐像素 `alpha >= 26` 判定实心，把落在实心像素上的面片抽出来单独
 *     渲染并施加上半兰伯特光照 —— 这就是安卓版立体感的来源，也是"塑料纸"的反面。
 *   · 片元着色器公式逐字照抄规格书第 3 节。
 *   · 预乘 alpha 混合：blendFunc(ONE, ONE_MINUS_SRC_ALPHA) + 贴图上传前预乘。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* ------------------------------ 规格书常量 ------------------------------ */

/** 光方向（规格书 §3，逐字照抄，不要动） */
const LIGHT_DIR = new THREE.Vector3(0.371, 0.743, 0.557);
/** 实心判定阈值（规格书 §2：是 26，不是 255） */
const ALPHA_THRESHOLD = 26;
/** 相机视场角（规格书 §4） */
const FOV = 50;
/** 固定的 zoom 系数（规格书 §4） */
const ZOOM = 0.9;
/** 手势缩放的等价范围（规格书 §4） */
const SCALE_MIN = 0.7;
const SCALE_MAX = 2.0;
/** 双击判定间隔（规格书 §4） */
const DOUBLE_TAP_MS = 300;
/** 图层的光照选择：规格书只规定了基础网格 0 / 实心层 1，图层按基础网格处理 */
const LAYER_LIGHT_MIX = 0;

const MODEL_DIR = './assets/skin_model/';
/** 默认皮肤（规格书 §6） */
const DEFAULT_SKIN = { classic: 'steve.png', slim: 'alex.png' };

/* ------------------------------ 着色器 ------------------------------ */

/** 顶点：法线用 three 注入的 normalMatrix 变换（= 规格书的 uNormalMatrix * aNormal） */
const VERTEX_SHADER = `
  varying vec2 vTexCoord;
  varying vec3 vNormal;
  void main() {
    vTexCoord = uv;
    vNormal = normalMatrix * normal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** 片元：逐字照抄规格书第 3 节公式 */
const FRAGMENT_SHADER = `
  uniform sampler2D uTexture;
  uniform float uLightMix;
  varying vec2 vTexCoord;
  varying vec3 vNormal;
  void main() {
    vec4 color = texture2D(uTexture, vTexCoord);
    if (color.a < 0.1) discard;
    float light = mix(1.0, 0.70 + 0.42 * max(dot(normalize(vNormal), vec3(0.371, 0.743, 0.557)), 0.0), uLightMix);
    gl_FragColor = vec4(color.rgb * light, color.a);
  }
`;

function makeMaterial(texture, lightMix) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTexture: { value: texture },
      uLightMix: { value: lightMix },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthTest: true,
    depthWrite: true,
    side: THREE.FrontSide,
    // 预乘 alpha：blendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA)
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
  });
}

/* ------------------------------ 皮肤贴图 ------------------------------ */

/** 程序化经典 Steve 皮肤（拿不到任何皮肤图片时的兜底，保证人物不空白） */
export function createSteveSkin() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const S = {
    skin: '#c68f6e',
    skinShade: '#b07d5e',
    hair: '#33261b',
    eyeWhite: '#ffffff',
    eyeIris: '#3b2c8a',
    mouth: '#6b4a38',
    shirt: '#00afaf',
    shirtShade: '#009b9b',
    pants: '#3f3fbf',
    pantsShade: '#3737a8',
    shoe: '#4c4c4c',
  };
  const f = (x, y, w, h, col) => {
    ctx.fillStyle = col;
    ctx.fillRect(x, y, w, h);
  };
  // 头
  f(8, 0, 8, 8, S.hair);
  f(16, 0, 8, 8, S.skinShade);
  f(0, 8, 8, 8, S.skin);
  f(0, 8, 8, 2, S.hair);
  f(8, 8, 8, 8, S.skin);
  f(8, 8, 8, 2, S.hair);
  f(9, 12, 2, 1, S.eyeWhite);
  f(13, 12, 2, 1, S.eyeWhite);
  f(10, 12, 1, 1, S.eyeIris);
  f(13, 12, 1, 1, S.eyeIris);
  f(11, 14, 2, 1, S.mouth);
  f(16, 8, 8, 8, S.skin);
  f(16, 8, 8, 2, S.hair);
  f(24, 8, 8, 8, S.hair);
  // 身体
  f(20, 16, 8, 4, S.shirt);
  f(28, 16, 8, 4, S.shirtShade);
  f(16, 20, 4, 12, S.shirt);
  f(20, 20, 8, 12, S.shirt);
  f(28, 20, 4, 12, S.shirtShade);
  f(32, 20, 8, 12, S.shirtShade);
  // 右臂
  f(44, 16, 4, 4, S.shirt);
  f(48, 16, 4, 4, S.skin);
  f(40, 20, 4, 12, S.shirt);
  f(44, 20, 4, 8, S.shirt);
  f(44, 28, 4, 4, S.skin);
  f(48, 20, 4, 8, S.shirtShade);
  f(48, 28, 4, 4, S.skin);
  f(52, 20, 4, 8, S.shirtShade);
  f(52, 28, 4, 4, S.skin);
  // 右腿
  f(4, 16, 4, 4, S.pants);
  f(8, 16, 4, 4, S.shoe);
  f(0, 20, 4, 12, S.pants);
  f(4, 20, 4, 12, S.pants);
  f(8, 20, 4, 12, S.pantsShade);
  f(12, 20, 4, 12, S.pantsShade);
  f(0, 27, 4, 5, S.shoe);
  f(4, 27, 4, 5, S.shoe);
  f(8, 27, 4, 5, S.shoe);
  f(12, 27, 4, 5, S.shoe);
  return c;
}

/** 把任意图片整理成能用的皮肤源（记录尺寸与是否为细手臂） */
function inspectSkin(image) {
  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  if (w !== 64 || (h !== 64 && h !== 32)) return { slim: false, usable: false };
  if (h === 32) return { slim: false, usable: true }; // 老式皮肤一律粗手臂
  // 64×64：普通层右臂区域最右一列透明 ⇒ 细手臂（3px 宽）
  try {
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 64;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(image, 0, 0);
    const isTransparent = (x, y) => cx.getImageData(x, y, 1, 1).data[3] < ALPHA_THRESHOLD;
    const thin = isTransparent(54, 20) && isTransparent(55, 20) && !isTransparent(46, 20);
    return { slim: thin, usable: true };
  } catch (err) {
    return { slim: false, usable: true };
  }
}

/** 从图片读取像素（用于实心层判定）；跨域失败时返回 null */
function readPixels(image) {
  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  try {
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingEnabled = false;
    cx.drawImage(image, 0, 0, w, h);
    return { data: cx.getImageData(0, 0, w, h).data, width: w, height: h };
  } catch (err) {
    return null;
  }
}

/* ------------------------------ 实心层几何 ------------------------------ */

/**
 * 抽取「UV 落在实心像素上」的面片，生成实心层几何（规格书 §2 第 2 层）。
 * 判定：一个三角形的 3 个 UV 与重心采样全部 alpha >= 26 才保留。
 */
function buildSolidGeometry(baseGeometry, pixels) {
  if (!pixels) return null;
  const src = baseGeometry.index ? baseGeometry.toNonIndexed() : baseGeometry.clone();
  const pos = src.getAttribute('position');
  if (!pos) return null;
  const uv = src.getAttribute('uv');
  if (!uv) return src;

  const { data, width, height } = pixels;
  const alphaAt = (u, v) => {
    let x = Math.floor(u * width);
    let y = Math.floor(v * height);
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x >= width) x = width - 1;
    if (y >= height) y = height - 1;
    return data[(y * width + x) * 4 + 3];
  };

  const triCount = Math.floor(pos.count / 3);
  const kept = [];
  for (let t = 0; t < triCount; t += 1) {
    const i0 = t * 3;
    const i1 = i0 + 1;
    const i2 = i0 + 2;
    const u0 = uv.getX(i0);
    const v0 = uv.getY(i0);
    const u1 = uv.getX(i1);
    const v1 = uv.getY(i1);
    const u2 = uv.getX(i2);
    const v2 = uv.getY(i2);
    const cu = (u0 + u1 + u2) / 3;
    const cv2 = (v0 + v1 + v2) / 3;
    const solid =
      alphaAt(u0, v0) >= ALPHA_THRESHOLD &&
      alphaAt(u1, v1) >= ALPHA_THRESHOLD &&
      alphaAt(u2, v2) >= ALPHA_THRESHOLD &&
      alphaAt(cu, cv2) >= ALPHA_THRESHOLD;
    if (solid) kept.push(i0);
  }
  if (kept.length === 0) return null;

  const outPos = new Float32Array(kept.length * 3 * 3);
  const outUv = new Float32Array(kept.length * 3 * 2);
  const srcNormal = src.getAttribute('normal');
  const outNormal = srcNormal ? new Float32Array(kept.length * 3 * 3) : null;

  let p = 0;
  let q = 0;
  let r = 0;
  for (const i0 of kept) {
    for (let k = 0; k < 3; k += 1) {
      const i = i0 + k;
      outPos[p] = pos.getX(i);
      outPos[p + 1] = pos.getY(i);
      outPos[p + 2] = pos.getZ(i);
      p += 3;
      outUv[q] = uv.getX(i);
      outUv[q + 1] = uv.getY(i);
      q += 2;
      if (outNormal) {
        outNormal[r] = srcNormal.getX(i);
        outNormal[r + 1] = srcNormal.getY(i);
        outNormal[r + 2] = srcNormal.getZ(i);
        r += 3;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(outUv, 2));
  if (outNormal) geo.setAttribute('normal', new THREE.BufferAttribute(outNormal, 3));
  else geo.computeVertexNormals(); // 面片法线：方块模型正好需要这种硬边光照
  geo.computeBoundingSphere();
  src.dispose();
  return geo;
}

/* ------------------------------ 视图 ------------------------------ */

export class SkinViewer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = options;
    this.rotationX = options.rotationX != null ? options.rotationX : 0;
    this.rotationY = options.rotationY != null ? options.rotationY : -20;
    this.scale = 1;
    this.style = options.style || 'classic';
    this.skinUrl = null;
    this.skinImage = null;
    this.pixels = null;
    this.currentAnimation = 'idle';
    this.animationNames = [];
    this.ready = false;
    this.destroyed = false;
    this.lastTapAt = 0;

    this.width = 0;
    this.height = 0;
    this.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

    this.models = new Map(); // style -> gltf
    this.loading = new Map();
    this.mixers = [];
    this.activeClip = null;

    this._initThree();
    this._bindEvents();
    // ★ 模型加载完不要立刻套贴图：贴图还没准备（this.texture 还是 null）。
    //   正确顺序由调用方走 useDefaultSkin()，或由 app.js 加载真实皮肤后调 setSkinImage()。
    //   之前这里写成 `this._loadModel(style).then(() => this._applySkin())`：
    //   ① `_applySkin` 这个方法根本不存在（真正的方法名是 `_applyTextureToModel`）；
    //   ② 即使改名，贴图仍为 null，会得到一张纯黑的人。
    this._loadModel(this.style).catch((err) => {
      console.error('[QCL] 人物模型加载失败：', err);
    });
  }

  /* ---------------------------- three 初始化 ---------------------------- */

  _initThree() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      /**
       * ★★★ 必须开 preserveDrawingBuffer。
       *
       * 不开时，WebGL 会在每帧结束后清空绘制缓冲区；浏览器合成器（以及
       * `capturePage`、窗口截图、透明窗口的合成）读到的是**已被清空的内容**。
       * 症状极迷惑：`gl.readPixels` 能读到 14 万个人物像素、`elementFromPoint`
       * 也确认画布在最顶层，但**窗口上就是空的**——因为合成发生在清空之后。
       * 透明窗口（transparent: true + alpha: true）下尤其明显。
       */
      preserveDrawingBuffer: true,
    });
    this.renderer.setClearColor(0x000000, 0);
    // 与安卓版一致：不做 sRGB 转换、不做色调映射，着色器算出来的就是最终颜色
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 2000);
    /** 外层旋转 wrapper（规格书 §4：旋转作用在模型 wrapper 上） */
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    this._updateCamera();
    this.resize();
  }

  /** distance = 4.5 + 16.5 / tan(fov/2) / zoom / scale，clamp [10, 256] */
  _updateCamera() {
    const half = (FOV * Math.PI) / 180 / 2;
    /**
     * ★★★ 相机距离必须按**模型实际尺寸**来算，不能照抄规格书的 `16.5` 常数。
     *
     * 规格书 §4 写的 `distance = 4.5 + 16.5/tan(fov/2)/zoom/scale`，那个 `16.5` 是
     * 安卓版给**它自己那套 Pixel 标定**留的；我们这份 glTF 的人物高度只有 **2 个单位**
     * （Minecraft 人物 32px = 2 格），照抄公式会得到 44 的距离 ——
     * 该距离下可见高度 41 个单位，人物只占画布 **4.9%**（实测只画出 22×40 像素，
     * 看起来就是「主界面没有人物」）。
     *
     * 正确做法：让模型高度占画布视野的 `FRAME_FILL`（这里取 0.72，即约 72% 高），
     * 反算 `distance = modelHeight / (2 * tan(fov/2) * FRAME_FILL * zoomScale)`。
     * 没有包围盒信息时回落到「按 2 个单位高」的等效值。
     */
    const modelHeight = Math.max(0.5, this._modelHeight || 2.0);
    const fill = 0.72 * this.scale; // scale 越大 → 人物越大（fill 变大 → 距离变小）
    const distance = modelHeight / (2 * Math.tan(half) * fill);
    this.camera.position.set(0, 0, Math.max(2.2, Math.min(60, distance)));
    this.camera.lookAt(0, 0, 0);
    this.camera.up.set(0, 1, 0);
    this.camera.updateProjectionMatrix();
  }

  /* ---------------------------- 资源加载 ---------------------------- */

  _loadModel(style) {
    if (this.models.has(style)) return Promise.resolve(this.models.get(style));
    if (this.loading.has(style)) return this.loading.get(style);

    const url = `${MODEL_DIR}${style === 'slim' ? 'slim' : 'classic'}-player.gltf`;
    const p = new Promise((resolve, reject) => {
      new GLTFLoader().load(
        url,
        (gltf) => {
          try {
            this._prepareModel(gltf, style);
            this.models.set(style, gltf);
            resolve(gltf);
          } catch (err) {
            reject(err);
          }
        },
        undefined,
        (err) => reject(err instanceof Error ? err : new Error(String(err && err.message ? err.message : err)))
      );
    });
    this.loading.set(style, p);
    return p;
  }

  /** 准备模型：归一化根变换、隐藏披风、按基础网格生成实心层、建立材质与渲染次序 */
  _prepareModel(gltf, style) {
    const root = gltf.scene;

    /**
     * ★★★ 关键：归一化 Blockbench/Cinema4D 导出时留下的根偏移。
     *
     * 这个 glTF 的层级里 `CINEMA_4D_Editor` 带着 `translation = [-0.98, 1.25, 4.62]`，
     * 也就是**整个模型被推后了 4.62 个单位**并整体偏移到一侧。
     * 安卓版看不出来，是因为它的相机按「模型贴脸」的标定来算距离；
     * 我们照规格书 §4 的 `distance = 4.5 + 16.5/tan(fov/2)/zoom/scale` 得到 44，
     * 再叠加这 4.62 的偏移，人物就缩到画布上只剩 22×40 像素（实测），看起来「没有人」。
     * ⇒ 二选一：要么改相机，要么把模型摆正。摆正更正确，也方便以后接入任意第三方皮肤模型。
     */
    const wrapper = root.getObjectByName('CINEMA_4D_Editor');
    if (wrapper) {
      wrapper.position.set(0, 0, 0);
      wrapper.rotation.set(0, 0, 0);
      wrapper.scale.set(1, 1, 1);
      wrapper.updateMatrix();
    }
    // 把整个模型居中到原点（按包围盒算），保证旋转轴心是人物自己而不是某个角落
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty() === false) {
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      // 水平居中、竖直也居中（人物高度约 2 格）
      root.position.sub(center);
      gltf.userData.size = size;
      // ★ 记录模型真实高度，供相机按尺寸取景（见 _updateCamera）
      this._modelHeight = Math.max(0.5, size.y);
    }
    root.updateMatrixWorld(true);

    root.traverse((obj) => {
      if (obj.isMesh) {
        /**
         * ★★★ 2026-11-05 修（用户实测「主界面人物没有同步背后的披风」）。
         *
         * 以前这里是**无条件隐藏**：
         *     // 披风没有对应贴图 ⇒ 先隐藏（规格书 §1）
         *     if (/cape/i.test(obj.name)) { obj.visible = false; obj.userData.isCape = true; }
         * 于是披风从上线到现在**一次都没显示过** —— 但模型里明明有 Cape_2 网格，
         * Mojang 也明明返回了 capeUrl（你的账号就有）。
         *
         * ⇒ 现在改成：默认隐藏（避免没有披风时出现一块白板），但标记为 isCape；
         *    一旦 setCapeImage() 拿到披风贴图就把它显示出来。
         */
        if (/cape/i.test(obj.name)) {
          obj.visible = false; // 先藏，等贴图来了再显示
          obj.userData.isCape = true;
          if (obj.geometry && !obj.geometry.getAttribute('normal')) obj.geometry.computeVertexNormals();
        }
      }
    });

    // 基础网格 → 实心层
    const baseMeshes = [];
    root.traverse((obj) => {
      if (obj.isMesh && !obj.userData.isCape && /_2$/.test(obj.name)) baseMeshes.push(obj);
    });

    for (const mesh of baseMeshes) {
      mesh.userData.baseMesh = true;
      mesh.renderOrder = 1;
      if (mesh.geometry) {
        if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
        mesh.geometry.computeBoundingSphere();
      }
      // 实心层占位：贴图确定后再生成（generateSolidLayer）
      mesh.userData.solidMesh = null;
    }

    root.traverse((obj) => {
      if (!obj.isMesh) return;
      if (obj.userData.isCape) return;
      if (!obj.userData.baseMesh) {
        // 图层（Hat_Layer / Body_Layer / *_Arm_Layer / *_Leg_Layer）
        obj.userData.layerMesh = true;
        obj.renderOrder = 3;
        if (obj.geometry && !obj.geometry.getAttribute('normal')) obj.geometry.computeVertexNormals();
      }
    });

    // 动画：默认 idle，变体 idle_sub_*
    this.animationNames = (gltf.animations || []).map((c) => c.name);
    this.mixers.push({ style, mixer: null, actions: null, root });
    this.pivot.add(root);
    root.visible = false;
  }

  /** 实例化动画系统（每个模型一套 mixer、一套 action 缓存） */
  _ensureMixer(style) {
    const gltf = this.models.get(style);
    if (!gltf || !gltf.animations || gltf.animations.length === 0) return null;
    let entry = this.mixers.find((m) => m.style === style);
    if (!entry) {
      entry = { style, root: gltf.scene };
      this.mixers.push(entry);
    }
    if (!entry.mixer) {
      entry.mixer = new THREE.AnimationMixer(gltf.scene);
      entry.actions = new Map();
      for (const clip of gltf.animations) {
        const action = entry.mixer.clipAction(clip);
        action.enabled = true;
        entry.actions.set(clip.name, action);
      }
    }
    return entry;
  }

  /* ---------------------------- 贴图 → 材质 ---------------------------- */

  /** 建立（或更新）贴图：预乘 alpha、最近邻放大、clamp 包装、不转色彩空间 */
  _makeTexture(image) {
    const tex = new THREE.Texture(image);
    tex.flipY = false; // glTF 的 UV 原点在左上
    tex.colorSpace = THREE.NoColorSpace; // 与安卓版一致：原样采样，不做 sRGB 解码
    tex.premultiplyAlpha = true; // 规格书：预乘 alpha
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  /** 把贴图刷到某一套模型的所有材质上（基础 / 实心层 / 图层 必须同时换） */
  _applyTextureToModel(gltf) {
    const tex = this.texture;
    if (!tex || !gltf) return;
    gltf.scene.traverse((obj) => {
      if (!obj.isMesh) return;
      if (obj.userData.solidMesh) {
        obj.userData.solidMesh.material.uniforms.uTexture.value = tex;
      }
      if (obj.material && obj.material.uniforms && obj.material.uniforms.uTexture) {
        obj.material.uniforms.uTexture.value = tex;
      }
    });
  }

  /* ------------------------------------------------------------ 披风 */

  /**
   * 设置披风贴图（照 Mojang 的 cape 纹理，64×32）。
   *
   * ★★★ 2026-11-05 新增（用户实测「主界面人物没有同步背后的披风」）。
   *   之前披风网格被**无条件隐藏**（`obj.visible = false` 写死在模型加载里），
   *   所以即使 Mojang 返回了 capeUrl（真实验证：HaoGE201123 就有披风），
   *   主界面也永远看不到。
   *
   * 实现要点：
   *   ① 披风贴图是独立的 64×32 图（不是皮肤的一部分），要单独建 texture；
   *   ② 只对 `userData.isCape` 的网格生效；
   *   ③ 贴图到位后把网格 visible = true；
   *   ④ 传 null 表示「这个账号没有披风」→ 隐藏网格，不留白板。
   *
   * @param {HTMLImageElement|HTMLCanvasElement|null} image
   * @returns {boolean} 是否成功设置
   */
  setCapeImage(image) {
    if (!image) {
      // 没有披风：隐藏所有披风网格
      for (const [, gltf] of this.models) {
        gltf.scene.traverse((obj) => {
          if (obj.isMesh && obj.userData.isCape) obj.visible = false;
        });
      }
      if (this.capeTexture) {
        this.capeTexture.dispose();
        this.capeTexture = null;
      }
      this._needsRender = true;
      return false;
    }

    try {
      /**
       * ★★★ 2026-11-05 修（用户实测「披风才渲染一丁点，根本没有全部渲染，而且渲染出错了」）。
       *
       * 根因（实测数据，别再猜）：**披风贴图的采样参数和皮肤不一致**。
       *   · glTF 的 UV 原点在左上 ⇒ 贴图必须 `flipY = false`；皮肤走 `_makeTexture()` 是对的，
       *     而这里以前用 `new THREE.Texture(image)`，默认 `flipY = true` ⇒ **整张披风被上下翻转**。
       *   · 披风 UV 只用 V 0~0.5313（64×32 图的第 0~16 行，标准披风布局）；
       *     翻过来之后采样到的是第 15~31 行 —— 实测该披风贴图第 22 行往下**全是透明**，
       *     于是 shader 的 `if (color.a < 0.1) discard;` 把绝大部分面片丢掉。
       *     12 个三角形里只剩 3.35 个还有不透明像素（覆盖率 3.35/12 ≈ 28%），
       *     表现就是「腰上一条黑带」「只渲染一丁点」。改成 flipY = false 后覆盖率 11.53/12。
       *   · 以前还漏了 `premultiplyAlpha`：材质用的是预乘 alpha 混合
       *     （blendSrc = OneFactor），贴图不预乘 ⇒ 边缘发白发脏；`colorSpace` 写成 sRGB
       *     而渲染器 outputColorSpace = LinearSRGB ⇒ 颜色偏暗（「渲染出错了」）。
       *
       * ⇒ 直接复用 `_makeTexture()`：皮肤与披风从此共用同一套贴图参数，不会再走偏。
       *
       * ★ 顺带排除的假说（实测否定，别再来回改）：
       *   `_prepareModel()` 里 `Box3.setFromObject(root)` **不受 visible 影响**
       *   （three 0.169 的 expandByObject 不看 visible），披风包围盒一直被算进去了；
       *   实测「含披风中心」与「身体中心」完全相等，root.position 的居中偏移没有问题。
       */
      const tex = this._makeTexture(image);

      const old = this.capeTexture;
      this.capeTexture = tex;

      for (const [, gltf] of this.models) {
        gltf.scene.traverse((obj) => {
          if (!obj.isMesh || !obj.userData.isCape) return;
          if (obj.material && obj.material.uniforms && obj.material.uniforms.uTexture) {
            obj.material.uniforms.uTexture.value = tex;
          } else if (obj.material) {
            obj.material.map = tex;
            obj.material.needsUpdate = true;
          }
          obj.visible = true;
        });
      }

      if (old) old.dispose();
      this._needsRender = true;
      return true;
    } catch (err) {
      console.error('[QCL] 披风贴图设置失败：', err);
      return false;
    }
  }

  /**
   * 从 URL / data URL 加载披风并应用。
   * @param {string} url
   * @returns {Promise<boolean>}
   */
  async setCapeFromUrl(url, timeoutMs = 8000) {
    if (!url) {
      this.setCapeImage(null);
      return false;
    }
    try {
      const img = await this._loadImage(url, timeoutMs);
      return this.setCapeImage(img);
    } catch {
      // 加载失败就当没有披风，不要显示一块空白
      this.setCapeImage(null);
      return false;
    }
  }

  /** 生成实心层（贴图变化时必须重算，因为依赖像素 alpha） */
  _regenerateSolidLayers(gltf) {
    gltf.scene.traverse((obj) => {
      if (!obj.isMesh || !obj.userData.baseMesh) return;

      if (obj.userData.solidMesh) {
        obj.parent.remove(obj.userData.solidMesh);
        obj.userData.solidMesh.geometry.dispose();
        obj.userData.solidMesh.material.dispose();
        obj.userData.solidMesh = null;
      }

      const geo = buildSolidGeometry(obj.geometry, this.pixels);
      if (!geo) return;

      const mat = makeMaterial(this.texture, 1); // 实心层：uLightMix = 1
      const solid = new THREE.Mesh(geo, mat);
      solid.name = `${obj.name}__solid`;
      solid.position.copy(obj.position);
      solid.quaternion.copy(obj.quaternion);
      solid.scale.copy(obj.scale);
      solid.renderOrder = 2;
      solid.frustumCulled = false;
      obj.parent.add(solid);
      obj.userData.solidMesh = solid;
    });
  }

  /** 生成基础网格 / 图层的材质（基础 uLightMix=0，图层按 LAYER_LIGHT_MIX） */
  _ensureMaterials(gltf) {
    gltf.scene.traverse((obj) => {
      if (!obj.isMesh || obj.userData.solidMesh) return;

      /**
       * ★★★ 2026-11-05 修（用户实测「披风显示成黑色方块」）。
       *
       * 以前这里 `if (obj.userData.isCape) return;` —— **披风被跳过**，
       * 于是它一直用 glTF 里的**默认材质**（没有贴图 ⇒ 渲染成纯黑/纯白块）。
       * 表现就是人物旁边挂着一块黑方块。
       *
       * ⇒ 现在给披风也建同一个自定义 shader 材质，但用 `this.capeTexture`（可能为 null，
       *   等 setCapeImage() 来了再填）。这样它至少有正确的材质结构，不会变黑块。
       */
      if (obj.userData.isCape) {
        const oldCape = obj.material;
        const nextCape = makeMaterial(this.capeTexture || this.texture, 0);
        obj.material = nextCape;
        if (oldCape && oldCape.dispose && oldCape !== nextCape) oldCape.dispose();
        /**
         * ★ 细手臂模型是「后来才加载」的：`_prepareModel()` 里披风网格默认 `visible = false`，
         *   而 `setCapeImage()` 可能在这之前就已经把披风贴图设好了（账号先套皮肤再切 slim）。
         *   以前只靠 setCapeImage 里的循环显示披风 ⇒ 新加载的模型披风永远是隐藏的。
         *   ⇒ 材质刷新时如果已经有披风贴图，就同步把网格显示出来（反之保持隐藏，不留白板）。
         */
        if (this.capeTexture) obj.visible = true;
        return;
      }

      const lightMix = obj.userData.baseMesh ? 0 : LAYER_LIGHT_MIX;
      const old = obj.material;
      const next = makeMaterial(this.texture, lightMix);
      obj.material = next;
      if (old && old.dispose && old !== next) old.dispose();
    });
  }

  /* ---------------------------- 对外：换皮肤 ---------------------------- */

  /** 用一张已就绪的图片（或 canvas）作为皮肤；会自动切粗/细手臂模型 */
  async setSkinImage(image, { switchStyle = true } = {}) {
    this.skinImage = image;
    const info = inspectSkin(image);
    this.pixels = readPixels(image);
    this.texture = this._makeTexture(image);
    if (this.texture) this.texture.needsUpdate = true;

    if (switchStyle && info.usable) {
      const want = info.slim ? 'slim' : 'classic';
      if (want !== this.style) await this._switchStyle(want);
    }
    await this._refreshCurrentModel();
    return info;
  }

  /** 兼容旧调用：canvas 皮肤 */
  setSkinFromCanvas(canvas) {
    this.setSkinImage(canvas, { switchStyle: false });
    return true;
  }

  /**
   * 用 data URL（base64 PNG）设置皮肤。
   *
   * ★ 为什么需要这个方法：主进程读文件后传过来的是 `data:image/png;base64,...`。
   *   直接喂给 `_loadImage` 也能 work，但这里单独抽一个方法，好处是：
   *     · 明确语义（知道来源是本地文件，可做额外的合法性检查）
   *     · 失败时抛出可读错误，而不是静默回落
   * @returns {Promise<boolean>} 是否成功
   */
  async setSkinFromDataUrl(dataUrl, timeoutMs = 8000) {
    if (!dataUrl || typeof dataUrl !== 'string' || dataUrl.indexOf('data:image') !== 0) {
      return false;
    }
    try {
      const img = await this._loadImage(dataUrl, timeoutMs);
      await this.setSkinImage(img);
      this.skinUrl = null;
      return true;
    } catch (err) {
      console.error('[QCL] data URL 皮肤加载失败：', err);
      return false;
    }
  }

  /** 兼容旧调用：从 URL 加载皮肤（失败回落默认贴图，绝不留空白） */
  async loadSkinFromUrl(url, timeoutMs = 6000) {
    if (!url) {
      await this.useDefaultSkin();
      return false;
    }
    try {
      const img = await this._loadImage(url, timeoutMs);
      await this.setSkinImage(img);
      return true;
    } catch (err) {
      await this.useDefaultSkin();
      return false;
    }
  }

  /** 用内置默认皮肤（classic → steve.png / slim → alex.png） */
  async useDefaultSkin() {
    const file = DEFAULT_SKIN[this.style] || DEFAULT_SKIN.classic;
    try {
      const img = await this._loadImage(`${MODEL_DIR}${file}`, 6000);
      this.skinUrl = null;
      await this.setSkinImage(img, { switchStyle: false });
      return true;
    } catch (err) {
      // 连自带贴图都拿不到：用程序化 Steve 顶上，绝不留空白
      await this.setSkinImage(createSteveSkin(), { switchStyle: false });
      return false;
    }
  }

  _loadImage(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('皮肤图片加载超时'));
      }, timeoutMs);
      img.onload = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(img);
      };
      img.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('皮肤图片加载失败'));
      };
      img.src = url;
    });
  }

  async _switchStyle(style) {
    this.style = style;
    try {
      await this._loadModel(style);
    } catch (err) {
      console.error('[QCL] 切换人物模型失败：', err);
    }
  }

  /** 贴图/像素变化后，把当前模型的材质、实心层、可见性刷新一遍 */
  async _refreshCurrentModel() {
    // ★★★ 模型可能还在加载中（首页刚 mount 就会调 useDefaultSkin）。
    //   以前这里 `this.models.get(this.style)` 拿不到就直接 return —— 皮肤被**静默丢弃**，
    //   模型永远没有材质，主界面就是一片空白（且没有任何报错）。
    //   ⇒ 现在先把当前模型 await 出来，再刷新。
    if (!this.models.has(this.style)) {
      try {
        await this._loadModel(this.style);
      } catch (err) {
        console.error('[QCL] 等待人物模型加载失败：', err);
        return;
      }
    }

    for (const [style, gltf] of this.models) {
      gltf.scene.visible = style === this.style;
    }
    const gltf = this.models.get(this.style);
    if (!gltf) return;

    this._ensureMaterials(gltf);
    this._regenerateSolidLayers(gltf);
    this._applyTextureToModel(gltf);

    const entry = this._ensureMixer(this.style);
    if (entry) this._playAnimation(this.currentAnimation);
    this.ready = true;
    this._needsRender = true;
  }

  /** 兼容旧调用（主页在换皮肤前会先调它） */
  setSkinFromUrl(url) {
    return this.loadSkinFromUrl(url);
  }

  /* ---------------------------- 动画 ---------------------------- */

  get animations() {
    return this.animationNames.slice();
  }

  setAnimation(name) {
    this.currentAnimation = name || 'idle';
    this._playAnimation(this.currentAnimation);
  }

  _playAnimation(name) {
    const entry = this.mixers.find((m) => m.style === this.style && m.actions);
    if (!entry) return;
    const actions = entry.actions;
    if (!actions || actions.size === 0) return;
    // 未知 id 一律回退 idle（规格书 §5）
    let key = name && actions.has(name) ? name : 'idle';
    if (!actions.has(key)) key = actions.keys().next().value;
    if (this.activeClip === key && entry.actions.get(key).isRunning()) return;
    for (const [k, a] of actions) {
      if (k !== key) a.fadeOut(0.25);
    }
    const action = actions.get(key);
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.fadeIn(0.25);
    action.play();
    this.activeClip = key;
  }

  /* ---------------------------- 交互 ---------------------------- */

  _bindEvents() {
    const c = this.canvas;
    this._onPointerDown = (e) => {
      this.dragging = true;
      this.dragMoved = false;
      this.pointerId = e.pointerId;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      try {
        c.setPointerCapture(e.pointerId);
      } catch (err) {
        /* 忽略 */
      }
    };
    this._onPointerMove = (e) => {
      if (!this.dragging || e.pointerId !== this.pointerId) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) this.dragMoved = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      const step = 0.55;
      this.rotationY += dx * step;
      this.rotationX = Math.max(-60, Math.min(60, this.rotationX + dy * step));
    };
    this._onPointerUp = (e) => {
      if (e && this.pointerId != null && e.pointerId !== this.pointerId) return;
      this.dragging = false;
      this.pointerId = null;
    };
    this._onWheel = (e) => {
      e.preventDefault();
      const next = this.scale * (e.deltaY > 0 ? 0.92 : 1.08);
      this.scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, next));
      this._updateCamera();
    };
    this._onDoubleClick = () => {
      const now = Date.now();
      if (now - this.lastTapAt < DOUBLE_TAP_MS) {
        this.resetView();
        this.lastTapAt = 0;
      } else {
        this.lastTapAt = now;
      }
    };

    c.addEventListener('pointerdown', this._onPointerDown);
    c.addEventListener('pointermove', this._onPointerMove);
    c.addEventListener('pointerup', this._onPointerUp);
    c.addEventListener('pointercancel', this._onPointerUp);
    c.addEventListener('lostpointercapture', this._onPointerUp);
    c.addEventListener('wheel', this._onWheel, { passive: false });
    c.addEventListener('dblclick', this._onDoubleClick);

    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(c.parentElement || c);
    } else {
      this._onResize = () => this.resize();
      window.addEventListener('resize', this._onResize);
    }
    if (typeof IntersectionObserver === 'function') {
      this._io = new IntersectionObserver((entries) => {
        this._visible = entries.some((x) => x.isIntersecting);
        // 从不可见变可见时补渲染一帧，避免「切回主页一片空白直到下一帧」
        if (this._visible) this._needsRender = true;
      });
      this._io.observe(c);
    }
  }

  resetView() {
    this.rotationX = 0;
    this.rotationY = -20;
    this.scale = 1;
    this._updateCamera();
  }

  /* ---------------------------- 尺寸与循环 ---------------------------- */

  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const w = Math.max(80, Math.floor(rect.width));
    const h = Math.max(80, Math.floor(rect.height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this.raf || this.destroyed) return;
    this.lastTime = 0;
    // ★ 首次进入时如果 IntersectionObserver 还没回调，_visible 是 undefined。
    //   这里显式先画一帧，保证即使观察器把 _visible 判成 false，画布也已经有人了。
    this._needsRender = true;
    const loop = (t) => {
      this.raf = requestAnimationFrame(loop);
      const dt = this.lastTime ? Math.min(0.064, (t - this.lastTime) / 1000) : 0.016;
      this.lastTime = t;
      if (this._visible === false && !this._needsRender) return;
      // 动画推进（规格书 §4：60fps 帧循环）
      for (const entry of this.mixers) {
        if (entry.mixer && entry.style === this.style) entry.mixer.update(dt);
      }
      // 外层旋转
      this.pivot.rotation.x = (this.rotationX * Math.PI) / 180;
      this.pivot.rotation.y = (this.rotationY * Math.PI) / 180;
      this.renderer.render(this.scene, this.camera);
      this._needsRender = false;
      this._frameCount = (this._frameCount || 0) + 1;
      this._lastFrameAt = Date.now();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  destroy() {
    this.destroyed = true;
    this.stop();
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._onPointerDown);
    c.removeEventListener('pointermove', this._onPointerMove);
    c.removeEventListener('pointerup', this._onPointerUp);
    c.removeEventListener('pointercancel', this._onPointerUp);
    c.removeEventListener('lostpointercapture', this._onPointerUp);
    c.removeEventListener('wheel', this._onWheel);
    c.removeEventListener('dblclick', this._onDoubleClick);
    if (this._ro) this._ro.disconnect();
    if (this._io) this._io.disconnect();
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    for (const entry of this.mixers) {
      if (entry.mixer) entry.mixer.stopAllAction();
    }
    this.mixers.length = 0;
    if (this.texture) this.texture.dispose();
    this.renderer.dispose();
  }
}

/** 供外部判断光照方向常量（调试/自测用） */
export const LIGHT_DIRECTION = LIGHT_DIR;
