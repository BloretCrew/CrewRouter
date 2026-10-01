'use strict';

const LABELS = {
  zh: { file: '文件', launcher: '返回启动页', logs: '打开日志目录', quit: '退出', view: '视图', reload: '重新加载', zoomIn: '放大', zoomOut: '缩小', resetZoom: '实际大小', fullscreen: '全屏', devtools: '开发者工具', window: '窗口', minimize: '最小化', close: '关闭窗口', about: '关于 CrewRouter Desktop' },
  en: { file: 'File', launcher: 'Back to launcher', logs: 'Open log folder', quit: 'Quit', view: 'View', reload: 'Reload', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', resetZoom: 'Actual Size', fullscreen: 'Toggle Full Screen', devtools: 'Developer Tools', window: 'Window', minimize: 'Minimize', close: 'Close Window', about: 'About CrewRouter Desktop' },
};

function buildMenuTemplate({ language = 'zh', isMac = process.platform === 'darwin', isDev = false, actions }) {
  const t = LABELS[language] || LABELS.zh;
  const template = [];
  if (isMac) template.push({ role: 'appMenu', submenu: [{ role: 'about', label: t.about }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit', label: t.quit }] });
  template.push({
    label: t.file,
    submenu: [
      { label: t.launcher, accelerator: 'CmdOrCtrl+Shift+H', click: () => actions.showLauncher() },
      { label: t.logs, click: () => actions.openLogs() },
      { type: 'separator' },
      ...(isMac ? [{ role: 'close', label: t.close }] : [{ role: 'quit', label: t.quit }]),
    ],
  });
  template.push({
    label: t.view,
    submenu: [
      { role: 'reload', label: t.reload },
      { type: 'separator' },
      { role: 'resetZoom', label: t.resetZoom },
      { role: 'zoomIn', label: t.zoomIn },
      { role: 'zoomOut', label: t.zoomOut },
      { type: 'separator' },
      { role: 'togglefullscreen', label: t.fullscreen },
      ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools', label: t.devtools }] : []),
    ],
  });
  if (isMac) template.push({ label: t.window, role: 'windowMenu' });
  return template;
}

function applyMenu({ electron, language, isDev, actions }) {
  const { Menu } = electron;
  if (!Menu) return null;
  const template = buildMenuTemplate({ language, isDev, actions });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  return template;
}

module.exports = { buildMenuTemplate, applyMenu, LABELS };
