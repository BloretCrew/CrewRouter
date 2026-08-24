/**
 * OAuth 授权确认页逻辑（独立小页面，不依赖 app.js）
 *
 * 流程：读取 URL 参数 → GET /oauth/authorize/info 拉取应用名/scope/API Key 列表
 *       → 用户选择密钥后原生表单 POST /oauth/authorize/approve → 服务端 302 回 loopback。
 */
(function () {
  'use strict';

  var qs = new URLSearchParams(location.search);
  var loadingEl = document.getElementById('ocLoading');
  var formEl = document.getElementById('ocForm');
  var errorEl = document.getElementById('ocError');
  var appNameEl = document.getElementById('ocAppName');
  var scopeListEl = document.getElementById('ocScopeList');
  var keySelectEl = document.getElementById('ocApiKeySelect');
  var hiddenWrap = document.getElementById('ocHiddenFields');

  // scope 标识 → i18n key（catalog 以中文原文为键，en.json 提供真翻译）
  var SCOPE_I18N_KEYS = {
    'events:report': '仅向 CrewRouter 上报客户端使用事件',
    'gateway:invoke': '通过网关调用模型接口',
    'console:read': '读取控制台数据（预留）'
  };

  function t(key) {
    return window.I18N ? I18N.t(key) : key;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function showError(msgKey) {
    loadingEl.style.display = 'none';
    formEl.style.display = 'none';
    errorEl.textContent = t(msgKey);
    errorEl.style.display = 'block';
  }

  // 把授权请求原参数回填为表单隐藏域，approve 端点据此二次校验并落库
  function fillHiddenFields() {
    var html = '';
    qs.forEach(function (value, key) {
      html += '<input type="hidden" name="' + esc(key) + '" value="' + esc(value) + '">';
    });
    hiddenWrap.innerHTML = html;
  }

  function renderScopes(scopes) {
    var html = '';
    (scopes || []).forEach(function (s) {
      var descKey = SCOPE_I18N_KEYS[s];
      html += '<li>'
        + '<span class="oc-scope-check"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>'
        + '<span>' + esc(t(descKey || s)) + ' <code>' + esc(s) + '</code></span>'
        + '</li>';
    });
    scopeListEl.innerHTML = html || '<li>-</li>';
  }

  function renderKeys(apiKeys, defaultId) {
    if (!apiKeys || !apiKeys.length) {
      showError('没有可用的 API Key，请先在控制台创建。');
      return;
    }
    var html = '';
    apiKeys.forEach(function (k) {
      var selected = defaultId != null && k.id === defaultId ? ' selected' : '';
      html += '<option value="' + esc(k.id) + '"' + selected + '>' + esc(k.name || ('API Key #' + k.id)) + '</option>';
    });
    keySelectEl.innerHTML = html;
  }

  function init() {
    fetch('/oauth/authorize/info?' + qs.toString(), { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) {
          showError('请先登录后再进行授权。');
          return null;
        }
        if (!r.ok) throw new Error('info failed');
        return r.json();
      })
      .then(function (info) {
        if (!info) return;
        loadingEl.style.display = 'none';
        formEl.style.display = 'block';
        appNameEl.textContent = info.client && info.client.name ? info.client.name : (info.client && info.client.id) || '-';
        renderScopes(info.scopes);
        renderKeys(info.apiKeys, info.defaultApiKeyId);
        fillHiddenFields();
        applyI18nToDynamicParts();
      })
      .catch(function () {
        showError('加载失败');
      });
  }

  // 动态渲染的部分（scope 行）需在 catalog 就绪/切换后重翻
  var lastScopes = [];
  function applyI18nToDynamicParts() {
    renderScopes(lastScopes);
  }

  var origRenderScopes = renderScopes;
  renderScopes = function (scopes) {
    lastScopes = scopes || lastScopes;
    origRenderScopes(lastScopes);
  };

  document.addEventListener('i18n:ready', applyI18nToDynamicParts);
  init();
})();
