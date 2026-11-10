'use strict';

// Background/foreground local CrewRouter server entry used by `cr start` / `cr serve`.
// It binds loopback by default and performs a full graceful shutdown on signals;
// server/index.js by itself only stops model-trace on SIGTERM.

process.env.CR_SKIP_AUTOSTART = '1';
if (process.env.CR_DEMO === '1') process.env.CR_DEMO = 'true';

const http = require('node:http');

let serverModule;
try {
  serverModule = require('../../server/index.js');
} catch (error) {
  console.error('[cr] 无法加载 CrewRouter Server:', error && error.stack ? error.stack : error);
  process.exit(1);
}

const { startServer, stopServer } = serverModule;
const host = process.env.CR_APP_HOST || '127.0.0.1';
const parsedPort = Number(process.env.CR_APP_PORT);
const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : undefined;
let stopping = false;

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  try {
    if (typeof stopServer === 'function') await stopServer();
  } catch (error) {
    console.error(`[cr] 停止服务失败（${signal}）:`, error && error.message ? error.message : error);
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGHUP', () => { shutdown('SIGHUP'); });
process.on('uncaughtException', (error) => {
  console.error('[cr] 未捕获异常:', error && error.stack ? error.stack : error);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (error) => {
  console.error('[cr] 未处理的 Promise 拒绝:', error && error.stack ? error.stack : error);
  shutdown('unhandledRejection');
});

startServer({ host, port }).then((server) => {
  if (server instanceof http.Server) {
    const address = server.address();
    const actual = address && typeof address === 'object' ? address.port : port;
    console.log(`[cr] 本地 CrewRouter 已启动：http://${host}:${actual}`);
  }
}).catch((error) => {
  console.error('[cr] 启动失败:', error && error.stack ? error.stack : error);
  process.exit(1);
});
