const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const ROOT = process.argv[process.argv.length-1];
const wait = (ms)=>new Promise(r=>setTimeout(r,ms));
app.commandLine.appendSwitch('no-sandbox');
app.whenReady().then(async ()=>{
  const win = new BrowserWindow({width:1600,height:900,show:false,frame:false,transparent:true,backgroundColor:'#00000000',
    webPreferences:{preload:path.join(ROOT,'src/preload/index.js'),contextIsolation:true,nodeIntegration:false,sandbox:false}});
  win.loadURL('qcl://app/index.html');
  await new Promise(r=>win.webContents.once('did-finish-load',r));
  await wait(2500);
  const img = await win.webContents.capturePage();
  const out = path.join(ROOT,'docs','_lead-capture.png');
  fs.writeFileSync(out, img.toPNG());
  console.log('CAPTURED', out, img.getSize());
  app.quit();
});
