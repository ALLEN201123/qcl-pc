const fs = require('node:fs');
const path = require('node:path');
const loaderinstall = require('../src/main/core/loaderinstall.js');
(async () => {
  const real = 'C:/Users/123/Documents/QCL';
  const home = path.join(__dirname, '.forge-probe-home');
  fs.rmSync(home, { recursive: true, force: true });
  const inst = path.join(home, 'instances', 't1');
  const mcDir = path.join(inst, '.minecraft');
  fs.mkdirSync(path.join(mcDir, 'versions', '26.3'), { recursive: true });
  // 拷真实 vanilla 26.3 JSON（只读用户目录）
  const srcJson = path.join(real, 'instances', 'mw2ee5w7-88c11ad3', '.minecraft', 'versions', '26.3', '26.3.json');
  if (fs.existsSync(srcJson)) { fs.copyFileSync(srcJson, path.join(mcDir, 'versions', '26.3', '26.3.json')); console.log('已拷贝 vanilla 26.3 JSON', fs.statSync(srcJson).size, 'bytes'); }
  // 拷缓存安装器
  const instDir = path.join(home, 'dependencies', 'installers');
  fs.mkdirSync(instDir, { recursive: true });
  fs.copyFileSync(path.join(real, 'dependencies', 'installers', '26.3-forge-66.1.5-installer.jar'), path.join(instDir, '26.3-forge-66.1.5-installer.jar'));
  console.log('安装器已拷贝');
  process.env._JAVA_OPTIONS = '-Xmx512m';
  const t0 = Date.now();
  const logs = [];
  try {
    const r = await loaderinstall.installLoader({
      home, instanceDir: inst, mcVersion: '26.3',
      loader: { type: 'forge', version: '66.1.5' },
      javaPath: 'C:\\Program Files\\Java\\jdk-25\\bin\\java.exe',
      onLog: (l) => { logs.push(l); if (/安装完成|生成|退出|失败|error|Exception/i.test(l)) console.log('  ·', String(l).slice(0, 160)); },
      onProgress: () => {},
    });
    console.log('结果:', JSON.stringify(r), '耗时', Date.now() - t0, 'ms');
  } catch (e) {
    console.log('失败:', e.message);
    console.log('最后日志:', logs.slice(-8).join('\n'));
  }
  const vdir = path.join(mcDir, 'versions');
  console.log('versions 目录:', fs.existsSync(vdir) ? fs.readdirSync(vdir).join(', ') : '无');
  console.log('temp home 体积约', (() => { let n=0; const walk=(d)=>{ for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p=path.join(d,e.name); if(e.isDirectory()) walk(p); else n+=fs.statSync(p).size; } }; walk(home); return (n/1024/1024).toFixed(1); })() , 'MB');
})().catch(e => { console.error('ERR', e); process.exit(1); });
