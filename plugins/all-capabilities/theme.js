/* 全能力示例主题的可选 JS 入口（manifest.themes[].js）
 *
 * 演示主题带脚本的能力：
 *  - 主题启用时由 plugin-runtime 注入 <script id="crPluginThemeScript">
 *  - 记忆用户偏好；颜色与纹理由官方主题令牌处理
 */
(function () {
  'use strict';

  // 记忆用户偏好示例（可被其他插件/主题读取）
  try { localStorage.setItem('cr:lastTheme', 'all-capabilities/all-capabilities-theme'); } catch (e) { /* 隐私模式静默 */ }
})();
