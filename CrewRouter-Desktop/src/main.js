'use strict';

const { createApp } = require('./app/create-app');

let electron = null;
try { electron = require('electron'); } catch { electron = null; }

// 只有在真正的 Electron 主进程里才启动；被 node 直接 require 时仅导出工厂便于测试。
if (electron && typeof electron === 'object' && electron.app) {
  createApp({ electron }).bootstrap();
}

module.exports = { createApp };
