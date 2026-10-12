'use strict';

// PostgreSQL provider 选择。
// - 打包/普通用户：内置 embedded-postgres。
// - Linux root 开发容器（PostgreSQL 拒绝以 root 运行）：优先系统 postgres 用户 + runuser 方案；没有时退回 embedded（由包创建 postgres 用户）。
const { createEmbeddedPostgresProvider, isEmbeddedPostgresAvailable, loadEmbeddedPostgres } = require('./embedded');
const { createSystemPostgresProvider, isSystemPostgresAvailable } = require('./system');

function isLinuxRoot() {
  return process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0;
}

async function resolvePostgresProvider({ prefer = process.env.CREWROUTER_POSTGRES_PROVIDER } = {}) {
  const system = isSystemPostgresAvailable();
  if (prefer === 'system') {
    if (system) return createSystemPostgresProvider();
    throw new Error('CREWROUTER_POSTGRES_PROVIDER=system 需要 Linux root 与 postgres 系统用户');
  }
  if (prefer !== 'embedded' && isLinuxRoot() && system) return createSystemPostgresProvider();
  try {
    await loadEmbeddedPostgres();
    return createEmbeddedPostgresProvider();
  } catch (error) {
    if (prefer !== 'embedded' && system) return createSystemPostgresProvider();
    throw new Error(`内置 PostgreSQL 加载失败（${process.platform}/${process.arch}）：${error.code || error.name}: ${error.message}`, { cause: error });
  }
}

module.exports = { resolvePostgresProvider, isEmbeddedPostgresAvailable, isSystemPostgresAvailable, isLinuxRoot };
