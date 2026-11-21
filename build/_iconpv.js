const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const HTML = process.argv[process.argv.length - 2];
const PNG = process.argv[process.argv.length - 1];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 620, height: 200, show: false, webPreferences: { offscreen: true } });
  await win.loadFile(HTML);
  await new Promise(r => setTimeout(r, 800));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(PNG, img.toPNG());
  app.exit(0);
});