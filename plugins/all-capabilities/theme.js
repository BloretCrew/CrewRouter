/* 全能力示例主题的可选 JS 入口（manifest.themes[].js）
 *
 * 演示主题带脚本的能力：
 *  - 主题启用时由 plugin-runtime 注入 <script id="crPluginThemeScript">
 *  - 可读取 --chart-* 等 CSS 变量做动态行为
 *  - 此处演示：读取图表主色做无缝切换时的短暂高亮，并记忆用户偏好
 */
(function () {
  'use strict';

  var readVar = window.readCssVar || function (name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback || '';
  };

  // 读取主题变量（canvas 场景同样应使用这种方式而非直接写 var()）
  var accent = readVar('--brand-blue', '#7c3aed');
  console.log('[all-capabilities theme] 主题 JS 已加载，主色 =', accent);

  // 切换主题时给页面顶部一个短暂的强调条，提示新主题已生效（1.2s 自动移除）
  var bar = document.getElementById('allCapabilitiesThemeFlash');
  if (bar) bar.remove();
  bar = document.createElement('div');
  bar.id = 'allCapabilitiesThemeFlash';
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:3px;z-index:9999;'
    + 'background:' + accent + ';transition:opacity .6s;pointer-events:none;';
  document.addEventListener('DOMContentLoaded', function () {
    document.body.appendChild(bar);
    setTimeout(function () { bar.style.opacity = '0'; }, 600);
    setTimeout(function () { bar.remove(); }, 1400);
  });
  if (document.readyState !== 'loading') {
    document.body.appendChild(bar);
    setTimeout(function () { bar.style.opacity = '0'; }, 600);
    setTimeout(function () { bar.remove(); }, 1400);
  }

  // 记忆用户偏好示例（可被其他插件/主题读取）
  try { localStorage.setItem('cr:lastTheme', 'all-capabilities/all-capabilities-theme'); } catch (e) { /* 隐私模式静默 */ }
})();
