const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
require('../src/main');
app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('Desktop window was not created');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await win.webContents.executeJavaScript("document.getElementById('local').click(); void 0");
  await new Promise((resolve) => setTimeout(resolve, 6500));
  fs.mkdirSync('../../artifacts/screenshots', { recursive: true });
  fs.writeFileSync('../../artifacts/screenshots/desktop-local-mode.png', (await win.webContents.capturePage()).toPNG());
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
setTimeout(() => app.exit(2), 30000);
