#!/usr/bin/env node
// 已废弃：本脚本用于"任务二 API Key 哈希化"时期的一次性迁移，会清空 api_keys.key_value 明文。
// 当前设计已改为"用户 API key 明文存储"，执行本脚本将破坏明文，故改为拒绝运行。
async function main() {
  console.error('[废弃] migrate-api-keys-hash 已被禁用：系统现以明文存储用户 API key，执行本脚本将破坏明文，请勿运行。');
  process.exitCode = 1;
}

main();