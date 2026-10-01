'use strict';

// PostgreSQL provider 选择。
// - 打包/普通用户：内置 embedded-postgres。
// - Linux root 开发容器（PostgreSQL 拒绝以 root 运行）：优先系统 postgres 用户 + runuser 方案；没有时退回 embedded（由包创建 postgres 用户）。
const { createEmbeddedPostgresProvider, isEmbeddedPostgresAvailable } = require('./embedded');
const { createSystemPostgresProvider, isSystemPostgresAvailable } = require('./system');

function isLinuxRoot() {
  return process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0;
}

function resolvePostgresProvider({ prefer = process.env.CREWROUTER_POSTGRES_PROVIDER } = {}) {
  const embedded = isEmbeddedPostgresAvailable();
  const system = isSystemPostgresAvailable();
  if (prefer === 'system') {
    if (system) return createSystemPostgresProvider();
    throw new Error('CREWROUTER_POSTGRES_PROVIDER=system 需要 Linux root 与 postgres 系统用户');
  }
  if (prefer === 'embedded') {
    if (embedded) return createEmbeddedPostgresProvider();
    throw new Error('CREWROUTER_POSTGRES_PROVIDER=embedded 需要安装 embedded-postgres 及当前平台的二进制包');
  }
  if (isLinuxRoot() && system) return createSystemPostgresProvider();
  if (embedded) return createEmbeddedPostgresProvider();
  if (system) return createSystemPostgresProvider();
  throw new Error('本地模式需要内置 PostgreSQL：请安装 embedded-postgres 及当前平台的 @embedded-postgres 二进制包');
}

module.exports = { resolvePostgresProvider, isEmbeddedPostgresAvailable, isSystemPostgresAvailable, isLinuxRoot };
