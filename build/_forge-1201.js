const fs = require('node:fs');
const path = require('node:path');
const http = require('../src/main/core/http.js');
const loaderinstall = require('../src/main/core/loaderinstall.js');
(async () => {
  const home = path.join(__dirname, '.forge-probe-1201');
  fs.rmSync(home, { recursive: true, force: true });
  const inst = path.join(home, 'instances', 't1');
  const mcDir = path.join(inst, '.minecraft');
  fs.mkdirSync(path.join(mcDir, 'versions', '1.20.1'), { recursive: true });
  // 取官方 1.20.1 版本 JSON（小）
  const manifest = await http.fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', { timeoutMs: 30000 });
  const hit = manifest.versions.find(v => v.id === '1.20.1');
  const json = await http.fetchJson(hit.url, { timeoutMs: 30000 });
  fs.writeFileSync(path.join(mcDir, 'versions', '1.20.1', '1.20.1.json'), JSON.stringify(json));
  console.log('1.20.1 JSON 已写入（', JSON.stringify(json).length, 'bytes）');
  // 客户端 jar：Forge 1.20.1 安装器处理链需要吗？先放一份（10MB）
  const jarBuf = await http.fetchBuffer(json.downloads.client.url, { timeoutMs: 180000 });
  fs.writeFileSync(path.join(mcDir, 'versions', '1.20.1', '1.20.1.jar'), jarBuf);
  console.log('1.20.1 客户端 jar:', jarBuf.length, 'bytes');
  process.env._JAVA_OPTIONS = '-Xmx512m';
  const t0 = Date.now();
  try {
    const r = await loaderinstall.installLoader({
      home, instanceDir: inst, mcVersion: '1.20.1',
      loader: { type: 'forge', version: '47.4.28' },
      javaPath: 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe',
      onLog: (l) => { if (/安装完成|生成|退出|失败|error|Exception|Downloading|downloading/i.test(l)) console.log('  ·', String(l).slice(0, 140)); },
      onProgress: () => {},
    });
    console.log('结果:', JSON.stringify(r), '耗时', Math.round((Date.now()-t0)/1000), 's');
  } catch (e) {
    console.log('失败:', e.message.slice(0, 500), '耗时', Math.round((Date.now()-t0)/1000), 's');
  }
  const vdir = path.join(mcDir, 'versions');
  console.log('versions:', fs.existsSync(vdir) ? fs.readdirSync(vdir).join(', ') : '无');
  let n=0; const walk=(d)=>{ try { for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p=path.join(d,e.name); if(e.isDirectory()) walk(p); else n+=fs.statSync(p).size; } } catch {} };
  walk(home);
  console.log('temp home 体积约', (n/1024/1024).toFixed(1), 'MB');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
