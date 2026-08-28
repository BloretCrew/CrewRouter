// 全能力示例插件 · 仪表盘插槽渲染脚本
// 约定：window.CrewPluginRegistry[pluginId].slots[renderName] = (container, helpers) => void
// 对应 plugin.json 中 slots: [{ page: 'dashboard', position: 'top', render: 'renderDashboardCard' }]
(function () {
  'use strict';
  var PLUGIN_ID = 'all-capabilities';

  window.CrewPluginRegistry = window.CrewPluginRegistry || {};
  window.CrewPluginRegistry[PLUGIN_ID] = window.CrewPluginRegistry[PLUGIN_ID] || {};
  window.CrewPluginRegistry[PLUGIN_ID].slots = window.CrewPluginRegistry[PLUGIN_ID].slots || {};

  window.CrewPluginRegistry[PLUGIN_ID].slots.renderDashboardCard = function (container, helpers) {
    var esc = (helpers && helpers.esc) || function (s) { return String(s == null ? '' : s); };
    container.innerHTML =
      '<div style="border:1px solid var(--border);border-radius:12px;padding:12px 16px;' +
      'background:var(--card);display:flex;align-items:center;gap:10px;">' +
      '<span style="font-size:18px;">🧩</span>' +
      '<div>' +
      '<div style="font-size:14px;font-weight:600;">' + esc('全能力示例插件已启用') + '</div>' +
      '<div style="font-size:12px;color:var(--muted-foreground);">' +
      esc('已演示全部 20 项权限；验证输出见服务日志，详情见设置页「全能力示例」。') +
      '</div>' +
      '</div>' +
      '</div>';
  };
})();
