// Theme Manager - Crant AI Studio
// Handles light/dark/system mode switching with localStorage persistence
class ThemeManager {
  constructor() {
    this.theme = localStorage.getItem('theme') || 'system';
    this._mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.init();
  }

  get resolvedTheme() {
    if (this.theme === 'system') {
      return this._mediaQuery.matches ? 'dark' : 'light';
    }
    return this.theme;
  }

  init() {
    this.applyTheme();
    this.bindEvents();
    this.initSystemListener();
  }

  initSystemListener() {
    this._mediaQuery.addEventListener('change', () => {
      if (this.theme === 'system') {
        this.applyTheme();
      }
    });
  }

  applyTheme() {
    const resolved = this.resolvedTheme;
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(resolved);
    document.documentElement.style.colorScheme = resolved;
    this.updateIcons();
    this.updateSFIcons();
  }

  updateIcons() {
    // 三态互斥显示：跟随系统只用电脑图标，避免与太阳/月亮叠在一起
    const mode = this.theme; // light | dark | system
    document.querySelectorAll('.icon-sun').forEach(icon => {
      icon.style.display = mode === 'light' ? 'block' : 'none';
    });
    document.querySelectorAll('.icon-moon').forEach(icon => {
      icon.style.display = mode === 'dark' ? 'block' : 'none';
    });
    document.querySelectorAll('.icon-system').forEach(icon => {
      icon.style.display = mode === 'system' ? 'block' : 'none';
    });
    // 更新按钮 title，便于辨识当前模式
    const titles = {
      light: '当前：浅色 · 点击切换深色',
      dark: '当前：深色 · 点击跟随系统',
      system: '当前：跟随系统 · 点击切换浅色'
    };
    const title = titles[mode] || '切换主题';
    document.querySelectorAll('#themeToggle, #themeToggleMobile').forEach(btn => {
      btn.setAttribute('title', title);
      btn.setAttribute('aria-label', title);
    });
  }

  updateSFIcons() {
    const color = this.resolvedTheme === 'dark' ? 'white' : 'black';
    document.querySelectorAll('.sf-icon').forEach(img => {
      const name = img.dataset.sfName;
      if (name) {
        img.src = `https://img.bloret.net/SF/${name}?color=${color}`;
      }
    });
  }

  toggle() {
    // 三态循环: light → dark → system → light
    if (this.theme === 'light') {
      this.theme = 'dark';
    } else if (this.theme === 'dark') {
      this.theme = 'system';
    } else {
      this.theme = 'light';
    }
    localStorage.setItem('theme', this.theme);
    this.applyTheme();
  }

  bindEvents() {
    const toggleButtons = document.querySelectorAll('#themeToggle');
    toggleButtons.forEach(btn => {
      btn.addEventListener('click', () => this.toggle());
    });
  }
}

// Helper: create SF icon img element
function sfIcon(name, size, className) {
  const color = (window.themeManager?.resolvedTheme || 'dark') === 'dark' ? 'white' : 'black';
  const cls = className ? `sf-icon ${className}` : 'sf-icon';
  return `<img src="https://img.bloret.net/SF/${name}?color=${color}" alt="" width="${size || 20}" height="${size || 20}" class="${cls}" data-sf-name="${name}" style="display:inline-block;vertical-align:middle;">`;
}

// Initialize theme manager
document.addEventListener('DOMContentLoaded', () => {
  window.themeManager = new ThemeManager();
});
