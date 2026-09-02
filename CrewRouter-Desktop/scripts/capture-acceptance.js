const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { sandbox: false } });
  await win.loadURL('http://127.0.0.1:20003/');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await win.webContents.executeJavaScript("localStorage.setItem('theme','light'); document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light'); document.documentElement.style.colorScheme='light'; void 0");
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.mkdirSync('../artifacts/screenshots', { recursive: true });
  fs.writeFileSync('../artifacts/screenshots/main-light-badge.png', (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("localStorage.setItem('theme','dark'); document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark'); document.documentElement.style.colorScheme='dark'; void 0");
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.writeFileSync('../artifacts/screenshots/main-dark-badge.png', (await win.webContents.capturePage()).toPNG());
  await win.loadFile(require('node:path').join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  fs.writeFileSync('../artifacts/screenshots/desktop-local-mode.png', (await win.webContents.capturePage()).toPNG());
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
setTimeout(() => app.exit(2), 15000);
