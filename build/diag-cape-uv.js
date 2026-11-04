'use strict';
/**
 * 诊断披风网格的 UV：为什么渲染成一个小黑条
 *
 * 疑点：glTF 里 Cape_2 的 UV 可能是按「皮肤贴图 64×64」烘焙的，
 *       而披风贴图是独立的 64×32，绑上去就采样到错误区域。
 */

const fs = require('node:fs');
const path = require('node:path');

const GLTF = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'skin_model', 'classic-player.gltf');
const BIN = GLTF.replace(/\.gltf$/, '.bin');

const g = JSON.parse(fs.readFileSync(GLTF, 'utf8'));

function readAccessor(idx) {
  const acc = g.accessors[idx];
  const bv = g.bufferViews[acc.bufferView];
  const buf = g.buffers[bv.buffer];
  const file = buf.uri ? path.join(path.dirname(GLTF), buf.uri) : BIN;
  const data = fs.readFileSync(file);
  const compSize = { 5126: 4, 5123: 2, 5121: 1 }[acc.componentType] || 4;
  const numComp = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type] || 1;
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || compSize * numComp;
  const out = [];
  for (let i = 0; i < acc.count; i += 1) {
    const off = base + i * stride;
    const item = [];
    for (let c = 0; c < numComp; c += 1) {
      const p = off + c * compSize;
      if (acc.componentType === 5126) item.push(data.readFloatLE(p));
      else if (acc.componentType === 5123) item.push(data.readUInt16LE(p));
      else item.push(data.readUInt8(p));
    }
    out.push(numComp === 1 ? item[0] : item);
  }
  return out;
}

const capes = g.nodes.filter((n) => /cape/i.test(n.name || ''));
console.log('═══ 披风节点 ═══');
for (const n of capes) {
  console.log(`  ${n.name}  mesh=${n.mesh}  translation=${JSON.stringify(n.translation)}  rotation=${JSON.stringify(n.rotation)}`);
}

// 找 Cape_2（有 mesh 的那个）
const target = capes.find((n) => n.mesh !== undefined);
if (target) {
  const mesh = g.meshes[target.mesh];
  console.log(`\n═══ 网格 ${mesh.name} ═══`);
  const prim = mesh.primitives[0];
  const pos = readAccessor(prim.attributes.POSITION);
  const uv = readAccessor(prim.attributes.TEXCOORD_0);

  const xs = pos.map((p) => p[0]);
  const ys = pos.map((p) => p[1]);
  const zs = pos.map((p) => p[2]);
  console.log(`  顶点数 ${pos.length}`);
  console.log(`  X: ${Math.min(...xs).toFixed(4)} ~ ${Math.max(...xs).toFixed(4)}`);
  console.log(`  Y: ${Math.min(...ys).toFixed(4)} ~ ${Math.max(...ys).toFixed(4)}`);
  console.log(`  Z: ${Math.min(...zs).toFixed(4)} ~ ${Math.max(...zs).toFixed(4)}`);
  console.log(`  → 尺寸 ${(Math.max(...xs) - Math.min(...xs)).toFixed(4)} × ${(Math.max(...ys) - Math.min(...ys)).toFixed(4)} × ${(Math.max(...zs) - Math.min(...zs)).toFixed(4)}`);

  const us = uv.map((p) => p[0]);
  const vs = uv.map((p) => p[1]);
  console.log(`\n  UV U: ${Math.min(...us).toFixed(4)} ~ ${Math.max(...us).toFixed(4)}`);
  console.log(`  UV V: ${Math.min(...vs).toFixed(4)} ~ ${Math.max(...vs).toFixed(4)}`);

  // 换算成像素（按 64×64 皮肤）
  console.log(`\n  按 64×64 皮肤贴图换算：`);
  console.log(`    U 像素: ${(Math.min(...us) * 64).toFixed(1)} ~ ${(Math.max(...us) * 64).toFixed(1)}`);
  console.log(`    V 像素: ${(Math.min(...vs) * 64).toFixed(1)} ~ ${(Math.max(...vs) * 64).toFixed(1)}`);
  console.log(`  按 64×32 披风贴图换算：`);
  console.log(`    U 像素: ${(Math.min(...us) * 64).toFixed(1)} ~ ${(Math.max(...us) * 64).toFixed(1)}`);
  console.log(`    V 像素: ${(Math.min(...vs) * 32).toFixed(1)} ~ ${(Math.max(...vs) * 32).toFixed(1)}`);

  // Minecraft 标准披风 UV（64×32 贴图）：
  // 正面 (0,0)-(10,16)  → U 0~0.15625, V 0~0.5
  // 背面 (10,0)-(20,16)
  console.log(`\n  Minecraft 标准披风 UV（64×32）：`);
  console.log(`    正面 U 0 ~ 0.15625, V 0 ~ 0.5`);
  console.log(`    背面 U 0.15625 ~ 0.3125, V 0 ~ 0.5`);
}

// 顺便看所有网格的 UV 范围，判断这套 glTF 的 UV 是给多大的贴图烘焙的
console.log('\n═══ 所有网格 UV 极值（判断贴图尺寸假设）═══');
let globalMax = 0;
for (const m of g.meshes) {
  const prim = m.primitives && m.primitives[0];
  if (!prim || prim.attributes.TEXCOORD_0 === undefined) continue;
  const uv = readAccessor(prim.attributes.TEXCOORD_0);
  const mx = Math.max(...uv.map((p) => p[0]), ...uv.map((p) => p[1]));
  globalMax = Math.max(globalMax, mx);
}
console.log(`  全部网格 UV 最大值: ${globalMax.toFixed(4)}`);
console.log(`  说明：若是 1.0 则 UV 已归一化，绑 64×32 或 64×64 都只看比值`);
