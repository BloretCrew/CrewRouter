'use strict';

// 启动页文案：zh / en 两套字典，key 缺失时回落到中文。
(function () {
  const zh = {
    'nav.settings': '设置', 'nav.back': '返回', 'nav.cancel': '取消', 'nav.confirm': '确定', 'nav.save': '保存',
    'chip.localRunning': '本地服务运行中',
    'hero.first': '首次启动', 'hero.welcome': '欢迎回来', 'hero.title': '开始使用 CrewRouter', 'hero.titleBack': '选择要打开的 CrewRouter',
    'hero.lead': '在这台电脑上本地使用，或连接已有的 CrewRouter 服务器。登录由目标服务器负责，Desktop 不保存凭据。',
    'hero.leadBack': '继续使用已保存的连接，或添加新的连接。',
    'saved.title': '已保存的连接', 'saved.count': '{count} 个', 'saved.connect': '连接', 'saved.more': '更多操作', 'saved.lastConnected': '上次连接 {time}', 'saved.never': '尚未连接',
    'choices.title': '选择一种方式', 'choices.titleMore': '添加新连接',
    'choice.local': '本地使用', 'choice.localDesc': '在这台电脑上运行 CrewRouter，无需登录',
    'choice.remote': '连接服务器', 'choice.remoteDesc': '通过官方站选择实例，或直接输入服务器地址',
    'local.eyebrow': '本地使用', 'local.title': '设置你的用户名', 'local.desc': '只需设置一次，用于显示在本地控制台和资料中；本地数据保存在这台电脑上。',
    'local.field': '用户名', 'local.hint': '可使用普通文字、数字或短横线，最多 64 个字符。', 'local.submit': '启动本地服务',
    'local.required': '用户名不能为空。', 'local.invalid': '用户名格式不符合要求。',
    'remote.eyebrow': '连接服务器', 'remote.title': '选择连接方式', 'remote.desc': 'Personal / Team 由目标服务器自动识别；登录在目标服务器完成。',
    'remote.official': '通过官方站连接', 'remote.officialDesc': '在浏览器中打开官方站，选择你登录过的 CrewRouter',
    'remote.custom': '输入服务器地址', 'remote.customDesc': '直接打开你填写的服务器，不经过官方站',
    'custom.title': '输入服务器地址', 'custom.desc': '仅支持 http:// 或 https:// 的公网地址；Desktop 不保存凭据。',
    'custom.field': '服务器地址', 'custom.hint': '仅支持 http:// 或 https:// 地址。', 'custom.submit': '连接',
    'custom.required': '请输入服务器地址。', 'custom.invalid': '请输入有效的 URL。', 'custom.protocol': '仅支持 http:// 或 https:// 地址。',
    'progress.eyebrow': '请稍候', 'progress.local': '正在启动本地服务', 'progress.remote': '正在连接服务器', 'progress.official': '等待官方站登录', 'progress.opening': '正在打开页面',
    'official.waitTitle': '请在浏览器中继续', 'official.waitDesc': '已在系统浏览器打开官方站。选择要登录的 CrewRouter 并完成授权后，Desktop 会自动打开它。', 'official.reopen': '重新打开浏览器链接',
    'error.title': '出了点问题', 'error.retry': '重试', 'error.logs': '查看日志',
    'settings.title': 'Desktop 设置', 'settings.preferences': '偏好', 'settings.autoConnect': '启动时自动连接上次的连接', 'settings.notifications': '启用桌面通知', 'settings.updateChecks': '检查更新',
    'settings.theme': '主题', 'settings.themeSystem': '跟随系统', 'settings.themeLight': '浅色', 'settings.themeDark': '深色', 'settings.language': '语言',
    'settings.localServer': '本地服务', 'settings.status': '状态', 'settings.pid': '进程 ID', 'settings.port': '端口', 'settings.version': '版本', 'settings.logs': '日志目录',
    'settings.running': '运行中', 'settings.stopped': '已停止', 'settings.restartLocal': '重启本地服务', 'settings.stopLocal': '停止', 'settings.openLogs': '打开日志目录',
    'settings.diagnostics': '诊断', 'settings.diagnosticsHint': '仅包含安全白名单字段，不包含 Token、Cookie 或 API Key。', 'settings.copy': '复制诊断信息', 'settings.copied': '已复制',
    'settings.app': '应用', 'settings.appHint': '重启会重新加载 Desktop；退出会停止桌面应用及其管理的本地服务。', 'settings.restartApp': '重启 Desktop', 'settings.quit': '退出',
    'confirm.stopLocal': '确定停止本地服务吗？停止后本地 CrewRouter 将不可用。', 'confirm.restartLocal': '确定重启本地服务吗？当前本地连接会短暂中断。',
    'confirm.restartApp': '确定重启 CrewRouter Desktop 吗？', 'confirm.quit': '确定退出 CrewRouter Desktop 吗？这会停止本地服务。',
    'confirm.deleteProfile': '确定删除“{name}”吗？只会从 Desktop 的已保存连接中移除。',
    'profile.renameTitle': '重命名连接', 'profile.nameField': '名称', 'profile.rename': '重命名', 'profile.delete': '删除',
    'footer.note': '登录由目标服务器负责；Desktop 不接管凭据。',
    'bridge.missing': '桌面桥接加载失败，请重启应用后重试。', 'busy': '已有操作正在进行，请稍候。',
  };
  const en = {
    'nav.settings': 'Settings', 'nav.back': 'Back', 'nav.cancel': 'Cancel', 'nav.confirm': 'Confirm', 'nav.save': 'Save',
    'chip.localRunning': 'Local server running',
    'hero.first': 'First launch', 'hero.welcome': 'Welcome back', 'hero.title': 'Get started with CrewRouter', 'hero.titleBack': 'Choose a CrewRouter to open',
    'hero.lead': 'Use CrewRouter locally on this computer, or connect to an existing server. The target server handles sign-in; Desktop never stores credentials.',
    'hero.leadBack': 'Continue with a saved connection or add a new one.',
    'saved.title': 'Saved connections', 'saved.count': '{count}', 'saved.connect': 'Connect', 'saved.more': 'More actions', 'saved.lastConnected': 'Last connected {time}', 'saved.never': 'Never connected',
    'choices.title': 'Choose how to start', 'choices.titleMore': 'Add a connection',
    'choice.local': 'Use locally', 'choice.localDesc': 'Run CrewRouter on this computer, no sign-in required',
    'choice.remote': 'Connect to a server', 'choice.remoteDesc': 'Pick an instance on the official site or enter a server address',
    'local.eyebrow': 'Local', 'local.title': 'Set your display name', 'local.desc': 'Set it once; it appears in the local console and your profile. Local data stays on this computer.',
    'local.field': 'Display name', 'local.hint': 'Letters, digits or dashes, up to 64 characters.', 'local.submit': 'Start local server',
    'local.required': 'Display name is required.', 'local.invalid': 'The display name contains unsupported characters.',
    'remote.eyebrow': 'Connect', 'remote.title': 'Choose a connection method', 'remote.desc': 'Personal / Team is detected from the target server; sign-in happens there.',
    'remote.official': 'Via the official site', 'remote.officialDesc': 'Open the official site in your browser and pick a CrewRouter you have signed in to',
    'remote.custom': 'Enter a server address', 'remote.customDesc': 'Open the server you specify, without the official site',
    'custom.title': 'Enter a server address', 'custom.desc': 'Only public http:// or https:// addresses; Desktop never stores credentials.',
    'custom.field': 'Server address', 'custom.hint': 'Only http:// or https:// addresses.', 'custom.submit': 'Connect',
    'custom.required': 'Enter a server address.', 'custom.invalid': 'Enter a valid URL.', 'custom.protocol': 'Only http:// or https:// addresses are supported.',
    'progress.eyebrow': 'Please wait', 'progress.local': 'Starting the local server', 'progress.remote': 'Connecting to the server', 'progress.official': 'Waiting for the official site', 'progress.opening': 'Opening the page',
    'official.waitTitle': 'Continue in your browser', 'official.waitDesc': 'The official site is open in your browser. Pick the CrewRouter to sign in to; Desktop opens it automatically afterwards.', 'official.reopen': 'Reopen the browser link',
    'error.title': 'Something went wrong', 'error.retry': 'Retry', 'error.logs': 'View logs',
    'settings.title': 'Desktop settings', 'settings.preferences': 'Preferences', 'settings.autoConnect': 'Connect to the last connection on startup', 'settings.notifications': 'Desktop notifications', 'settings.updateChecks': 'Check for updates',
    'settings.theme': 'Theme', 'settings.themeSystem': 'Follow system', 'settings.themeLight': 'Light', 'settings.themeDark': 'Dark', 'settings.language': 'Language',
    'settings.localServer': 'Local server', 'settings.status': 'Status', 'settings.pid': 'PID', 'settings.port': 'Port', 'settings.version': 'Version', 'settings.logs': 'Log folder',
    'settings.running': 'Running', 'settings.stopped': 'Stopped', 'settings.restartLocal': 'Restart local server', 'settings.stopLocal': 'Stop', 'settings.openLogs': 'Open log folder',
    'settings.diagnostics': 'Diagnostics', 'settings.diagnosticsHint': 'Only an allowlisted summary; tokens, cookies and API keys are never included.', 'settings.copy': 'Copy diagnostics', 'settings.copied': 'Copied',
    'settings.app': 'Application', 'settings.appHint': 'Restart reloads Desktop; quitting stops the app and the local server it manages.', 'settings.restartApp': 'Restart Desktop', 'settings.quit': 'Quit',
    'confirm.stopLocal': 'Stop the local server? Local CrewRouter becomes unavailable.', 'confirm.restartLocal': 'Restart the local server? The local connection is briefly interrupted.',
    'confirm.restartApp': 'Restart CrewRouter Desktop?', 'confirm.quit': 'Quit CrewRouter Desktop? This stops the local server.',
    'confirm.deleteProfile': 'Delete “{name}”? It is only removed from Desktop\'s saved connections.',
    'profile.renameTitle': 'Rename connection', 'profile.nameField': 'Name', 'profile.rename': 'Rename', 'profile.delete': 'Delete',
    'footer.note': 'The target server handles sign-in; Desktop never takes over credentials.',
    'bridge.missing': 'The desktop bridge failed to load. Please restart the app.', 'busy': 'Another action is in progress, please wait.',
  };
  const dict = { zh, en };
  let language = 'zh';
  const ATTRS = ['label', 'hint', 'placeholder', 'title', 'description', 'aria-label'];

  function t(key, vars) {
    const value = (dict[language] && dict[language][key]) ?? zh[key] ?? key;
    return vars ? String(value).replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? '')) : value;
  }
  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    ATTRS.forEach((attr) => {
      root.querySelectorAll(`[data-i18n-${attr}]`).forEach((el) => { el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`))); });
    });
  }
  function setLanguage(next) {
    language = dict[next] ? next : 'zh';
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    apply();
    return language;
  }
  function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    try { return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date); } catch { return date.toLocaleString(); }
  }
  window.CrewRouterDesktopI18n = Object.freeze({ t, apply, setLanguage, formatTime, has: (lang, key) => Boolean(dict[lang] && Object.prototype.hasOwnProperty.call(dict[lang], key)), get language() { return language; }, keys: Object.keys(zh) });
})();
