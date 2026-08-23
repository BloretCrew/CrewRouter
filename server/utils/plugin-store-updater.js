/**
 * 插件商店更新检测（实例侧）
 *
 * 对「从商店安装」且已启用的插件，定期（默认每 24 小时）向商店拉取 package-info，
 * 若商店版本高于已安装版本，则标记 store_update_available=true 并记录最新信息，
 * 供系统管理员在插件管理页看到「有更新」并选择是否升级。
 */

const Logger = require('../logger');
const storeClient = require('../plugins/store-client');

function getConfig() {
  try { return require('../config-loader'); } catch { return {}; }
}

function cmpVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function checkUpdates() {
  const { pool } = require('../models/database');
  const res = await pool.query(
    `SELECT id, name, version, store_id, store_source
     FROM plugins
     WHERE enabled = true AND store_id IS NOT NULL AND store_source IS NOT NULL`
  );
  let updatedCount = 0;
  for (const row of res.rows) {
    const source = row.store_source;
    const storeId = row.store_id;
    if (!source || !storeId) continue;
    try {
      if (!storeClient.isAllowedSource(source)) continue;
      const info = await storeClient.fetchPackageInfo(source, storeId);
      if (!info || !info.version) continue;
      const hasUpdate = cmpVersions(info.version, row.version) > 0;
      await pool.query(
        `UPDATE plugins SET
           store_checked_at = $2,
           store_latest_version = $3,
           store_update_available = $4,
           store_latest = $5::jsonb,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [
          row.id,
          new Date(),
          hasUpdate ? info.version : null,
          hasUpdate,
          hasUpdate
            ? JSON.stringify({ name: info.name, version: info.version, permissions: info.permissions || [], description: info.description || '' })
            : null,
        ]
      );
      if (hasUpdate) updatedCount++;
    } catch (e) {
      Logger.warn(`[plugin-store-updater] 检查 ${row.id} 更新失败: ${e.message}`);
    }
  }
  if (updatedCount) Logger.info(`[plugin-store-updater] 发现 ${updatedCount} 个插件可更新`);
  return updatedCount;
}

function start() {
  const cfg = getConfig();
  const sc = (cfg.store && cfg.store.updateCheck) || {};
  if (sc.enabled === false) {
    Logger.info('[plugin-store-updater] 已通过配置关闭（store.updateCheck.enabled=false）');
    return;
  }
  const hours = Math.max(1, Number(sc.intervalHours) || 24);
  const run = () => { checkUpdates().catch((e) => Logger.warn('[plugin-store-updater] 检查失败', e.message)); };
  run();
  setInterval(run, hours * 3600 * 1000);
  Logger.info(`[plugin-store-updater] 已启动，每 ${hours} 小时检查一次商店插件更新`);
}

module.exports = { checkUpdates, start, cmpVersions };
