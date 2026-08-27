/**
 * 插件商店存储层 —— PostgreSQL 后端
 *
 * 只读写 `plugin_store_*` 前缀的商店业务表，与系统表（plugins/plugin_data/providers/api_keys）
 * 逻辑隔离：不建外键、不 JOIN、不做破坏性迁移。连接复用 server/models/database 的 pool。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getPool } = require('./db');
const Logger = require('../logger');

// 商店使用中央站点真实连接池（demo 模式下主连接池为 mock，此处直接取真实池）
const pool = getPool();

const PLUGIN_ID_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

function q(sql, params) {
  return pool.query(sql, params);
}

async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

function validatePluginId(id) {
  if (!id || typeof id !== 'string') return '插件 id 必填';
  if (id.length < 3 || id.length > 128) return '插件 id 长度应在 3–128';
  if (!PLUGIN_ID_RE.test(id)) return '插件 id 格式无效（字母数字与 ._-）';
  return null;
}

function isHttpsUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeSha256(input) {
  if (input == null || input === '') return '';
  const s = String(input).trim().toLowerCase();
  if (!s) return '';
  if (!/^[a-f0-9]{64}$/.test(s)) {
    throw storeError('sha256 必须是 64 位十六进制', 'VALIDATION');
  }
  return s;
}

function buildBloretInstallUrl(plugin) {
  if (!plugin || !plugin.download) {
    throw storeError('缺少 download', 'VALIDATION');
  }
  const x = new URLSearchParams();
  x.set('download', plugin.download);
  for (const k of ['id', 'name', 'version', 'author', 'description', 'sha256']) {
    const v = plugin[k];
    if (v != null && String(v).trim()) x.set(k, String(v).trim());
  }
  x.set('source', 'store');
  return `bloret://plugin/install?${x.toString()}`;
}

function toStoreProposePayload(plugin) {
  const payload = {
    download: plugin.download || '',
    id: plugin.id || '',
    name: plugin.name || '',
    version: plugin.version || '',
    author: plugin.author || plugin.authorUsername || '',
    description: plugin.description || '',
    sha256: plugin.sha256 || '',
    source: 'store',
  };
  Object.keys(payload).forEach((k) => {
    if (k !== 'download' && k !== 'source' && !payload[k]) delete payload[k];
  });
  return payload;
}

function normalizePermissions(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map((p) => String(p).trim()).filter(Boolean);
  if (typeof input === 'string') return input.split(/[,，\s]+/).map((p) => p.trim()).filter(Boolean);
  return [];
}

function normalizeTags(input) {
  return normalizePermissions(input);
}

function storeError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function iso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function parseScreenshots(raw) {
  if (!raw) return [];
  let arr = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((item) => {
      if (!item) return null;
      if (typeof item === 'string') {
        const url = item.trim();
        return url ? { url, webpUrl: '' } : null;
      }
      const url = String(item.url || '').trim();
      if (!url) return null;
      return { url, webpUrl: String(item.webpUrl || item.webp_url || '').trim() };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeScreenshots(input) {
  const list = parseScreenshots(input);
  for (const shot of list) {
    if (!(isHttpsUrl(shot.url) || shot.url.startsWith('/'))) {
      throw storeError('截图 url 必须是 https:// 或站内路径', 'VALIDATION');
    }
    if (shot.webpUrl && !(isHttpsUrl(shot.webpUrl) || shot.webpUrl.startsWith('/'))) {
      throw storeError('截图 webpUrl 必须是 https:// 或站内路径', 'VALIDATION');
    }
  }
  return list;
}

function parsePendingUpdate(raw) {
  if (!raw) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  return {
    name: String(obj.name || '').trim(),
    version: String(obj.version || '').trim(),
    author: String(obj.author || '').trim(),
    description: String(obj.description || '').trim(),
    longDescription: String(obj.longDescription || obj.long_description || '').trim(),
    url: String(obj.url || '').trim(),
    icon: String(obj.icon || '').trim(),
    download: String(obj.download || '').trim(),
    sha256: String(obj.sha256 || '').trim(),
    permissions: Array.isArray(obj.permissions) ? obj.permissions.map((p) => String(p)) : [],
    tags: Array.isArray(obj.tags) ? obj.tags.map((t) => String(t)) : [],
    screenshots: parseScreenshots(obj.screenshots),
    submittedAt: obj.submittedAt ? iso(obj.submittedAt) : null,
  };
}

function editableFieldsFromPlugin(plugin) {
  return {
    name: plugin.name || '',
    version: plugin.version || '',
    author: plugin.author || '',
    description: plugin.description || '',
    longDescription: plugin.longDescription || '',
    url: plugin.url || '',
    icon: plugin.icon || '',
    download: plugin.download || '',
    sha256: plugin.sha256 || '',
    permissions: Array.isArray(plugin.permissions) ? plugin.permissions.slice() : [],
    tags: Array.isArray(plugin.tags) ? plugin.tags.slice() : [],
    screenshots: Array.isArray(plugin.screenshots)
      ? plugin.screenshots.map((s) => ({ url: s.url, webpUrl: s.webpUrl || '' }))
      : [],
  };
}

function rowToPlugin(row) {
  if (!row) return null;
  const pendingUpdate = parsePendingUpdate(row.pending_update);
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    author: row.author || '',
    authorUsername: row.author_username,
    authorNickname: row.author_nickname || row.author_username,
    description: row.description || '',
    longDescription: row.long_description || '',
    url: row.url || '',
    icon: row.icon || '',
    download: row.download,
    sha256: row.sha256 || '',
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    tags: Array.isArray(row.tags) ? row.tags : [],
    screenshots: parseScreenshots(row.screenshots),
    status: row.status,
    rejectReason: row.reject_reason || '',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    reviewedAt: iso(row.reviewed_at),
    reviewedBy: row.reviewed_by || null,
    installCount: Number(row.install_count || 0),
    ratingAvg: Number(row.rating_avg || 0),
    ratingCount: Number(row.rating_count || 0),
    featured: !!row.featured,
    pendingUpdate,
    hasPendingUpdate: !!pendingUpdate,
  };
}

function publicView(plugin, opts = {}) {
  if (!plugin) return null;
  const includePending = !!opts.includePending;
  const view = {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    author: plugin.author,
    authorUsername: plugin.authorUsername,
    authorNickname: plugin.authorNickname || plugin.authorUsername,
    description: plugin.description,
    longDescription: plugin.longDescription || '',
    url: plugin.url || '',
    icon: plugin.icon || '',
    download: plugin.download,
    sha256: plugin.sha256 || '',
    permissions: plugin.permissions || [],
    tags: plugin.tags || [],
    screenshots: plugin.screenshots || [],
    status: plugin.status,
    rejectReason: plugin.rejectReason || '',
    createdAt: plugin.createdAt,
    updatedAt: plugin.updatedAt,
    reviewedAt: plugin.reviewedAt,
    installCount: plugin.installCount || 0,
    ratingAvg: Number(plugin.ratingAvg || 0),
    ratingCount: Number(plugin.ratingCount || 0),
    featured: !!plugin.featured,
  };
  if (includePending) {
    view.hasPendingUpdate = !!plugin.hasPendingUpdate;
    view.pendingUpdate = plugin.pendingUpdate || null;
  }
  return view;
}

function canSeePending(plugin, user) {
  if (!plugin || !user) return false;
  if (user.admin) return true;
  if (user.username && user.username === plugin.authorUsername) return true;
  return false;
}

function toLauncherManifest(plugin) {
  return {
    name: plugin.name,
    master: plugin.authorNickname || plugin.author || plugin.authorUsername || 'unknown',
    authorUsername: plugin.authorUsername || '',
    authorNickname: plugin.authorNickname || plugin.authorUsername || '',
    download: plugin.download,
    version: plugin.version,
  };
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS plugin_store_plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  author_username TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  download TEXT NOT NULL,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reject_reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ NULL,
  reviewed_by TEXT NULL,
  install_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ps_plugins_status ON plugin_store_plugins (status);
CREATE INDEX IF NOT EXISTS idx_ps_plugins_author ON plugin_store_plugins (author_username);
CREATE INDEX IF NOT EXISTS idx_ps_plugins_updated ON plugin_store_plugins (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ps_plugins_tags ON plugin_store_plugins USING GIN (tags);
`;

const SCHEMA_EXTRA_SQL = `
ALTER TABLE plugin_store_plugins
  ADD COLUMN IF NOT EXISTS screenshots JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS rating_avg NUMERIC(3,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS long_description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sha256 TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pending_update JSONB NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname VARCHAR(255);

CREATE TABLE IF NOT EXISTS plugin_store_ratings (
  plugin_id TEXT NOT NULL REFERENCES plugin_store_plugins(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  stars SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (plugin_id, username)
);
CREATE INDEX IF NOT EXISTS idx_ps_ratings_plugin ON plugin_store_ratings (plugin_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS plugin_store_rating_replies (
  id BIGSERIAL PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  rating_username TEXT NOT NULL,
  username TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ps_replies_body_len CHECK (char_length(body) BETWEEN 1 AND 500),
  CONSTRAINT ps_replies_rating_fk
    FOREIGN KEY (plugin_id, rating_username)
    REFERENCES plugin_store_ratings (plugin_id, username)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ps_replies_rating ON plugin_store_rating_replies (plugin_id, rating_username, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_ps_replies_plugin ON plugin_store_rating_replies (plugin_id, created_at DESC);
`;

async function ensureSchema() {
  await q(SCHEMA_SQL);
  await q(SCHEMA_EXTRA_SQL);
  Logger.info('[store] plugin_store_* 表已就绪');
}

/**
 * 初始化（幂等）：建表 + 可选填充演示数据
 * @param {{seedDemo?: boolean}} opts
 */
async function init(opts = {}) {
  await ensureSchema();
  if (opts.seedDemo !== false) {
    await seedDemoIfEmpty();
  }
  Logger.info('[store] 插件商店存储层就绪 (PostgreSQL)');
}

const DEMO_PLUGINS = [
  {
    id: 'demo-hello-crewrouter',
    name: 'Demo Hello CrewRouter',
    version: '0.1.0',
    author: 'CrewRouter Demo',
    authorUsername: 'demo',
    description: '一个演示插件，展示商店浏览与详情页。',
    longDescription:
      '这是插件商店的演示数据，用于验证列表、详情、安装深链、评分等流程。真实插件可通过「提交插件」上架，经管理员审核后公开。',
    url: '',
    icon: '',
    download: 'https://example.com/releases/demo-hello-crewrouter.zip',
    sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    permissions: ['gateway:observe'],
    tags: ['demo', 'hello'],
    screenshots: [],
    status: 'approved',
    installCount: 12,
    featured: true,
  },
  {
    id: 'demo-theme-aurora',
    name: 'Aurora 主题',
    version: '1.2.0',
    author: 'CrewRouter Demo',
    authorUsername: 'demo',
    description: '极光风格主题插件，演示主题注册能力。',
    longDescription: '演示「主题」类插件的商店展示。',
    url: '',
    icon: '',
    download: 'https://example.com/releases/demo-theme-aurora.zip',
    sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    permissions: ['themes:register'],
    tags: ['theme', 'ui'],
    screenshots: [],
    status: 'approved',
    installCount: 5,
    featured: false,
  },
  {
    id: 'demo-tools-butler',
    name: 'Tools Butler',
    version: '0.3.1',
    author: 'CrewRouter Demo',
    authorUsername: 'demo',
    description: '工具类插件，批量处理网关数据。',
    longDescription: '演示工具类插件在商店中的展示。',
    url: '',
    icon: '',
    download: 'https://example.com/releases/demo-tools-butler.zip',
    sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    permissions: ['cron:register'],
    tags: ['tools', 'cron'],
    screenshots: [],
    status: 'pending',
    installCount: 0,
    featured: false,
  },
];

async function seedDemoIfEmpty() {
  const res = await q('SELECT COUNT(*)::int AS c FROM plugin_store_plugins');
  const count = res.rows[0] && res.rows[0].c;
  if (count > 0) return;
  for (const p of DEMO_PLUGINS) {
    await q(
      `INSERT INTO plugin_store_plugins (
        id, name, version, author, author_username, description, long_description,
        url, icon, download, sha256, permissions, tags, screenshots, status, install_count, featured
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17)
      ON CONFLICT (id) DO NOTHING`,
      [
        p.id, p.name, p.version, p.author, p.authorUsername, p.description, p.longDescription,
        p.url, p.icon, p.download, p.sha256, JSON.stringify(p.permissions), JSON.stringify(p.tags),
        JSON.stringify(p.screenshots), p.status, p.installCount, p.featured,
      ]
    );
  }
  Logger.info('[store] 已填充演示数据', DEMO_PLUGINS.length, '条');
}

async function listPlugins(opts = {}) {
  const isAdmin = !!opts.admin;
  const username = opts.username || null;
  const params = [];
  const where = [];

  if (opts.scope === 'mine' && username) {
    params.push(username);
    where.push(`author_username = $${params.length}`);
  } else if (opts.scope === 'admin' && isAdmin) {
    // 管理员看全部
  } else if (isAdmin) {
    // 管理员默认不过滤状态
  } else if (username) {
    params.push(username);
    where.push(`(status = 'approved' OR author_username = $${params.length})`);
  } else {
    where.push(`status = 'approved'`);
  }

  if (opts.status) {
    if (opts.status === 'pending') {
      where.push(`(status = 'pending' OR pending_update IS NOT NULL)`);
    } else {
      params.push(opts.status);
      where.push(`status = $${params.length}`);
    }
  }

  if (opts.tag) {
    params.push(opts.tag.toLowerCase());
    where.push(
      `EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) AS t(val) WHERE lower(t.val) = $${params.length})`
    );
  }

  if (opts.q) {
    params.push(`%${opts.q.toLowerCase()}%`);
    const i = params.length;
    where.push(
      `(lower(id) LIKE $${i} OR lower(name) LIKE $${i} OR lower(COALESCE(author,'')) LIKE $${i} OR lower(COALESCE(description,'')) LIKE $${i} OR lower(tags::text) LIKE $${i})`
    );
  }

  let orderBy = 'updated_at DESC';
  if (opts.sort === 'rating') {
    orderBy = 'rating_avg DESC NULLS LAST, rating_count DESC, updated_at DESC';
  } else if (opts.sort === 'installs') {
    orderBy = 'install_count DESC, updated_at DESC';
  }

  const sql = `SELECT p.*, u.nickname AS author_nickname
    FROM plugin_store_plugins p
    LEFT JOIN users u ON LOWER(u.username) = LOWER(p.author_username)
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${orderBy}`;
  const res = await q(sql, params);
  const includePending = opts.scope === 'mine' || opts.scope === 'admin';
  return res.rows.map((row) => publicView(rowToPlugin(row), { includePending }));
}

async function getPlugin(id) {
  const res = await q(`SELECT p.*, u.nickname AS author_nickname
    FROM plugin_store_plugins p
    LEFT JOIN users u ON LOWER(u.username) = LOWER(p.author_username)
    WHERE p.id = $1`, [id]);
  return rowToPlugin(res.rows[0]);
}

function canViewPlugin(plugin, user) {
  if (!plugin) return false;
  if (plugin.status === 'approved') return true;
  if (!user) return false;
  if (user.admin) return true;
  if (user.username === plugin.authorUsername) return true;
  return false;
}

async function createPlugin(input, authorUsername) {
  const idErr = validatePluginId(input.id);
  if (idErr) throw storeError(idErr, 'VALIDATION');
  if (!input.name || !String(input.name).trim()) throw storeError('插件名称必填', 'VALIDATION');
  if (!input.version || !String(input.version).trim()) throw storeError('版本号必填', 'VALIDATION');
  if (!input.download || !isHttpsUrl(input.download)) throw storeError('download 必须是 https:// 外链', 'VALIDATION');
  if (input.url && !isHttpsUrl(input.url)) throw storeError('主页 url 必须是 https://', 'VALIDATION');
  if (input.icon && !(isHttpsUrl(input.icon) || String(input.icon).startsWith('/'))) {
    throw storeError('icon 必须是 https:// 或站内路径', 'VALIDATION');
  }

  const screenshots = normalizeScreenshots(input.screenshots);
  const sha256 = normalizeSha256(input.sha256);
  const plugin = {
    id: String(input.id).trim(),
    name: String(input.name).trim(),
    version: String(input.version).trim(),
    author: String(input.author || authorUsername || '').trim() || authorUsername,
    authorUsername,
    description: String(input.description || '').trim(),
    longDescription: String(input.longDescription || input.long_description || '').trim(),
    url: input.url ? String(input.url).trim() : '',
    icon: input.icon ? String(input.icon).trim() : '',
    download: String(input.download).trim(),
    sha256,
    permissions: normalizePermissions(input.permissions),
    tags: normalizeTags(input.tags),
    screenshots,
  };

  try {
    const res = await q(
      `INSERT INTO plugin_store_plugins (
        id, name, version, author, author_username, description, long_description,
        url, icon, download, sha256, permissions, tags, screenshots, status, reject_reason, install_count
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,'pending','',0)
      RETURNING *`,
      [
        plugin.id, plugin.name, plugin.version, plugin.author, plugin.authorUsername,
        plugin.description, plugin.longDescription, plugin.url, plugin.icon, plugin.download,
        plugin.sha256, JSON.stringify(plugin.permissions), JSON.stringify(plugin.tags),
        JSON.stringify(plugin.screenshots),
      ]
    );
    Logger.info('[store] 创建插件', plugin.id, 'by', authorUsername);
    return publicView(rowToPlugin(res.rows[0]));
  } catch (e) {
    if (e && e.code === '23505') throw storeError('插件 id 已存在', 'DUPLICATE');
    Logger.error('[store] 创建失败', e.message);
    throw e;
  }
}

async function updatePlugin(id, input, user) {
  const existing = await getPlugin(id);
  if (!existing) throw storeError('插件不存在', 'NOT_FOUND');

  const isOwner = user && user.username === existing.authorUsername;
  const isAdmin = user && user.admin;
  if (!isOwner && !isAdmin) throw storeError('无权修改此插件', 'FORBIDDEN');

  let baseFields = editableFieldsFromPlugin(existing);
  if (isOwner && !isAdmin && existing.status === 'approved' && existing.pendingUpdate) {
    baseFields = {
      ...baseFields,
      ...editableFieldsFromPlugin({
        name: existing.pendingUpdate.name,
        version: existing.pendingUpdate.version,
        author: existing.pendingUpdate.author,
        description: existing.pendingUpdate.description,
        longDescription: existing.pendingUpdate.longDescription,
        url: existing.pendingUpdate.url,
        icon: existing.pendingUpdate.icon,
        download: existing.pendingUpdate.download,
        sha256: existing.pendingUpdate.sha256,
        permissions: existing.pendingUpdate.permissions,
        tags: existing.pendingUpdate.tags,
        screenshots: existing.pendingUpdate.screenshots,
      }),
    };
  }

  const next = { ...baseFields };
  if (input.name !== undefined) next.name = String(input.name ?? '').trim();
  if (input.version !== undefined) next.version = String(input.version ?? '').trim();
  if (input.author !== undefined) next.author = String(input.author ?? '').trim();
  if (input.description !== undefined) next.description = String(input.description ?? '').trim();
  if (input.download !== undefined) {
    if (!isHttpsUrl(input.download)) throw storeError('download 必须是 https:// 外链', 'VALIDATION');
    next.download = String(input.download).trim();
  }
  if (input.sha256 !== undefined) next.sha256 = normalizeSha256(input.sha256);
  if (input.url !== undefined) {
    if (input.url && !isHttpsUrl(input.url)) throw storeError('主页 url 必须是 https://', 'VALIDATION');
    next.url = input.url ? String(input.url).trim() : '';
  }
  if (input.icon !== undefined) next.icon = input.icon ? String(input.icon).trim() : '';
  if (input.permissions !== undefined) next.permissions = normalizePermissions(input.permissions);
  if (input.tags !== undefined) next.tags = normalizeTags(input.tags);
  if (input.screenshots !== undefined) next.screenshots = normalizeScreenshots(input.screenshots);
  if (input.longDescription !== undefined || input.long_description !== undefined) {
    next.longDescription = String(input.longDescription ?? input.long_description ?? '').trim();
  }
  if (!next.name) throw storeError('插件名称必填', 'VALIDATION');
  if (!next.version) throw storeError('版本号必填', 'VALIDATION');
  if (!next.download || !isHttpsUrl(next.download)) throw storeError('download 必须是 https:// 外链', 'VALIDATION');

  let featured = existing.featured;
  if (input.featured !== undefined && isAdmin) featured = !!input.featured;

  let status = existing.status;
  let rejectReason = existing.rejectReason || '';
  let reviewedAt = existing.reviewedAt;
  let reviewedBy = existing.reviewedBy;
  let pendingUpdate = existing.pendingUpdate;
  let applyToMain = true;

  if (isAdmin) {
    applyToMain = true;
    if (input.clearPendingUpdate || input.clearDraft) pendingUpdate = null;
  } else if (existing.status === 'pending' || existing.status === 'rejected') {
    applyToMain = true;
    if (existing.status === 'rejected') {
      status = 'pending';
      rejectReason = '';
      reviewedAt = null;
      reviewedBy = null;
    }
    pendingUpdate = null;
  } else if (existing.status === 'approved' && isOwner) {
    applyToMain = false;
    pendingUpdate = { ...next, submittedAt: new Date().toISOString() };
    rejectReason = '';
  }

  let res;
  if (applyToMain) {
    res = await q(
      `UPDATE plugin_store_plugins SET
        name=$2, version=$3, author=$4, description=$5, long_description=$6, url=$7, icon=$8,
        download=$9, sha256=$10, permissions=$11::jsonb, tags=$12::jsonb, screenshots=$13::jsonb,
        status=$14, reject_reason=$15, reviewed_at=$16::timestamptz, reviewed_by=$17, featured=$18,
        pending_update=$19::jsonb, updated_at=NOW()
      WHERE id=$1 RETURNING *`,
      [
        id, next.name, next.version, next.author, next.description, next.longDescription || '',
        next.url, next.icon, next.download, next.sha256 || '', JSON.stringify(next.permissions || []),
        JSON.stringify(next.tags || []), JSON.stringify(next.screenshots || []), status, rejectReason,
        reviewedAt, reviewedBy, !!featured, pendingUpdate ? JSON.stringify(pendingUpdate) : null,
      ]
    );
  } else {
    res = await q(
      `UPDATE plugin_store_plugins SET pending_update=$2::jsonb, reject_reason=$3, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id, pendingUpdate ? JSON.stringify(pendingUpdate) : null, rejectReason]
    );
  }

  Logger.info('[store] 更新插件', id, 'by', user && user.username, applyToMain ? 'main' : 'pending_update');
  return publicView(rowToPlugin(res.rows[0]), { includePending: true });
}

async function reviewPlugin(id, action, reason, reviewerUsername) {
  if (action !== 'approve' && action !== 'reject') {
    throw storeError('action 必须是 approve 或 reject', 'VALIDATION');
  }
  const existing = await getPlugin(id);
  if (!existing) throw storeError('插件不存在', 'NOT_FOUND');

  const draft = existing.pendingUpdate;
  const rejectReason = action === 'approve' ? '' : String(reason || '').trim() || '未通过审核';

  let res;
  if (draft) {
    if (action === 'approve') {
      res = await q(
        `UPDATE plugin_store_plugins SET
          name=$2, version=$3, author=$4, description=$5, long_description=$6, url=$7, icon=$8,
          download=$9, sha256=$10, permissions=$11::jsonb, tags=$12::jsonb, screenshots=$13::jsonb,
          status='approved', reject_reason='', pending_update=NULL, reviewed_at=NOW(), reviewed_by=$14, updated_at=NOW()
        WHERE id=$1 RETURNING *`,
        [
          id,
          draft.name || existing.name,
          draft.version || existing.version,
          draft.author != null ? draft.author : existing.author,
          draft.description != null ? draft.description : existing.description,
          draft.longDescription != null ? draft.longDescription : existing.longDescription || '',
          draft.url != null ? draft.url : existing.url || '',
          draft.icon != null ? draft.icon : existing.icon || '',
          draft.download || existing.download,
          draft.sha256 != null ? draft.sha256 : existing.sha256 || '',
          JSON.stringify(draft.permissions || existing.permissions || []),
          JSON.stringify(draft.tags || existing.tags || []),
          JSON.stringify(draft.screenshots || existing.screenshots || []),
          reviewerUsername,
        ]
      );
    } else {
      res = await q(
        `UPDATE plugin_store_plugins SET pending_update=NULL, reject_reason=$2, reviewed_at=NOW(), reviewed_by=$3, updated_at=NOW() WHERE id=$1 RETURNING *`,
        [id, rejectReason, reviewerUsername]
      );
    }
  } else {
    const status = action === 'approve' ? 'approved' : 'rejected';
    res = await q(
      `UPDATE plugin_store_plugins SET status=$2, reject_reason=$3, reviewed_at=NOW(), reviewed_by=$4, pending_update=NULL, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id, status, rejectReason, reviewerUsername]
    );
  }

  if (!res.rows[0]) throw storeError('插件不存在', 'NOT_FOUND');
  Logger.info('[store] 审核', action, id, 'by', reviewerUsername, draft ? 'draft' : 'plugin');
  return publicView(rowToPlugin(res.rows[0]), { includePending: true });
}

async function incrementInstall(id) {
  const res = await q(
    `UPDATE plugin_store_plugins SET install_count = install_count + 1 WHERE id = $1 AND status = 'approved' RETURNING id, install_count`,
    [id]
  );
  if (!res.rows[0]) {
    const exists = await getPlugin(id);
    if (!exists) throw storeError('插件不存在', 'NOT_FOUND');
    throw storeError('仅已上架插件可统计安装', 'FORBIDDEN');
  }
  return { id: res.rows[0].id, installCount: Number(res.rows[0].install_count) };
}

async function recomputeRatingStats(clientOrQueryOrConfig, pluginId) {
  const run = clientOrQueryOrConfig && clientOrQueryOrConfig.query
    ? (sql, params) => clientOrQueryOrConfig.query(sql, params)
    : (sql, params) => q(sql, params);
  const stats = await run(
    `SELECT COALESCE(AVG(stars)::numeric(3,2),0) AS avg, COUNT(*)::int AS cnt FROM plugin_store_ratings WHERE plugin_id = $1`,
    [pluginId]
  );
  const avg = Number(stats.rows[0].avg || 0);
  const cnt = Number(stats.rows[0].cnt || 0);
  await run(`UPDATE plugin_store_plugins SET rating_avg=$2, rating_count=$3, updated_at=updated_at WHERE id=$1`, [
    pluginId, avg, cnt,
  ]);
  return { ratingAvg: avg, ratingCount: cnt };
}

function ratingRowToPublic(row, replies) {
  if (!row) return null;
  return {
    pluginId: row.plugin_id,
    username: row.username,
    nickname: row.nickname || row.username,
    stars: Number(row.stars),
    comment: row.comment || '',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    replies: Array.isArray(replies) ? replies : [],
  };
}

function replyRowToPublic(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    pluginId: row.plugin_id,
    ratingUsername: row.rating_username,
    username: row.username,
    nickname: row.nickname || row.username,
    body: row.body || '',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function listRepliesForRatings(pluginId, ratingUsernames) {
  if (!ratingUsernames || !ratingUsernames.length) return new Map();
  const res = await q(
    `SELECT r.*, u.nickname
       FROM plugin_store_rating_replies r
       LEFT JOIN users u ON LOWER(u.username) = LOWER(r.username)
      WHERE r.plugin_id = $1 AND r.rating_username = ANY($2::text[])
      ORDER BY r.created_at ASC`,
    [pluginId, ratingUsernames]
  );
  const map = new Map();
  for (const row of res.rows) {
    const key = row.rating_username;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(replyRowToPublic(row));
  }
  return map;
}

async function listRatings(pluginId, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 50);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  const distRes = await q(
    `SELECT stars, COUNT(*)::int AS c FROM plugin_store_ratings WHERE plugin_id = $1 GROUP BY stars`,
    [pluginId]
  );
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of distRes.rows) distribution[Number(row.stars)] = Number(row.c);

  const plugin = await getPlugin(pluginId);
  if (!plugin) throw storeError('插件不存在', 'NOT_FOUND');

  const listRes = await q(
    `SELECT r.*, u.nickname
       FROM plugin_store_ratings r
       LEFT JOIN users u ON LOWER(u.username) = LOWER(r.username)
      WHERE r.plugin_id = $1
      ORDER BY r.updated_at DESC LIMIT $2 OFFSET $3`,
    [pluginId, limit, offset]
  );
  const usernames = listRes.rows.map((r) => r.username);
  const repliesMap = await listRepliesForRatings(pluginId, usernames);

  return {
    avg: plugin.ratingAvg || 0,
    count: plugin.ratingCount || 0,
    distribution,
    ratings: listRes.rows.map((row) => ratingRowToPublic(row, repliesMap.get(row.username) || [])),
    limit,
    offset,
  };
}

async function getUserRating(pluginId, username) {
  if (!username) return null;
  const res = await q(`SELECT r.*, u.nickname
    FROM plugin_store_ratings r
    LEFT JOIN users u ON LOWER(u.username) = LOWER(r.username)
    WHERE r.plugin_id = $1 AND r.username = $2`, [pluginId, username]);
  return ratingRowToPublic(res.rows[0]);
}

async function upsertRating(pluginId, username, input) {
  const plugin = await getPlugin(pluginId);
  if (!plugin) throw storeError('插件不存在', 'NOT_FOUND');
  if (plugin.status !== 'approved') throw storeError('仅已上架插件可评分', 'FORBIDDEN');
  const stars = Number(input && input.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw storeError('stars 必须是 1–5 的整数', 'VALIDATION');
  }
  const comment = String((input && input.comment) || '').trim();
  if (comment.length > 500) throw storeError('评论最多 500 字', 'VALIDATION');

  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const res = await client.query(
        `INSERT INTO plugin_store_ratings (plugin_id, username, stars, comment)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (plugin_id, username) DO UPDATE SET stars=EXCLUDED.stars, comment=EXCLUDED.comment, updated_at=NOW()
         RETURNING *`,
        [pluginId, username, stars, comment]
      );
      const stats = await recomputeRatingStats(client, pluginId);
      await client.query('COMMIT');
      return { rating: ratingRowToPublic(res.rows[0]), ...stats };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    }
  });
}

async function deleteRating(pluginId, username) {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const res = await client.query(
        `DELETE FROM plugin_store_ratings WHERE plugin_id = $1 AND username = $2 RETURNING *`,
        [pluginId, username]
      );
      if (!res.rows[0]) throw storeError('尚未评分', 'NOT_FOUND');
      const stats = await recomputeRatingStats(client, pluginId);
      await client.query('COMMIT');
      return stats;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    }
  });
}

async function createRatingReply(pluginId, ratingUsername, username, body) {
  const plugin = await getPlugin(pluginId);
  if (!plugin) throw storeError('插件不存在', 'NOT_FOUND');
  if (plugin.status !== 'approved') throw storeError('仅已上架插件可回复评论', 'FORBIDDEN');
  const target = String(ratingUsername || '').trim();
  if (!target) throw storeError('缺少被回复的评论', 'VALIDATION');
  const text = String(body || '').trim();
  if (!text) throw storeError('回复内容不能为空', 'VALIDATION');
  if (text.length > 500) throw storeError('回复最多 500 字', 'VALIDATION');

  const ratingRes = await q(`SELECT username FROM plugin_store_ratings WHERE plugin_id = $1 AND username = $2`, [
    pluginId, target,
  ]);
  if (!ratingRes.rows[0]) throw storeError('评论不存在', 'NOT_FOUND');

  const res = await q(
    `INSERT INTO plugin_store_rating_replies (plugin_id, rating_username, username, body) VALUES ($1,$2,$3,$4) RETURNING *`,
    [pluginId, target, username, text]
  );
  return replyRowToPublic(res.rows[0]);
}

async function deleteRatingReply(pluginId, replyId, actor) {
  const id = Number(replyId);
  if (!Number.isFinite(id) || id <= 0) throw storeError('无效的回复 id', 'VALIDATION');
  const existing = await q(`SELECT * FROM plugin_store_rating_replies WHERE id = $1 AND plugin_id = $2`, [
    id, pluginId,
  ]);
  const row = existing.rows[0];
  if (!row) throw storeError('回复不存在', 'NOT_FOUND');

  const actorName = actor && actor.username;
  const isOwner = actorName && actorName === row.username;
  const isAdmin = actor && actor.admin;
  if (!isOwner && !isAdmin) throw storeError('无权删除此回复', 'FORBIDDEN');

  await q(`DELETE FROM plugin_store_rating_replies WHERE id = $1`, [id]);
  return { ok: true, id: String(id) };
}

async function listRelated(plugin, opts = {}) {
  if (!plugin || !plugin.id) return [];
  const limit = Math.min(Math.max(Number(opts.limit) || 6, 1), 12);
  const tags = Array.isArray(plugin.tags) ? plugin.tags : [];
  const res = await q(
    `SELECT p.*,
      (SELECT COUNT(*)::int FROM jsonb_array_elements_text(p.tags) AS t(val) WHERE lower(t.val) = ANY($2::text[])) AS tag_overlap
     FROM plugin_store_plugins p
     WHERE p.status = 'approved' AND p.id <> $1
     ORDER BY tag_overlap DESC, p.rating_count DESC, p.install_count DESC, p.updated_at DESC
     LIMIT $3`,
    [plugin.id, tags.map((t) => String(t).toLowerCase()), limit]
  );
  return res.rows.map((row) => publicView(rowToPlugin(row)));
}

/** 清理验证期间写入的测试数据（仅操作 plugin_store_* 表；按传入条件或全表清空） */
async function clearAllData() {
  await q('DELETE FROM plugin_store_rating_replies');
  await q('DELETE FROM plugin_store_ratings');
  await q('DELETE FROM plugin_store_plugins');
  Logger.info('[store] 已清空 plugin_store_* 表数据（保留表结构）');
}

// ---------- 插件包信息（供实例拉取 / 商店详情「行为」展示） ----------
const manifestCache = new Map(); // key -> { at, payload }
const MANIFEST_CACHE_TTL_MS = 10 * 60 * 1000;

// 从未解压的 zip（临时文件）中读取 plugin.json（防目录穿越，仅允许相对路径）
function readManifestFromZip(zipPath, pluginId) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile('/usr/bin/unzip', ['-Z1', zipPath], { timeout: 15000 }, (err, stdout) => {
      if (err) return resolve(null);
      const entries = String(stdout).split('\n').map((s) => s.trim()).filter(Boolean);
      let target = null;
      if (entries.includes('plugin.json')) target = 'plugin.json';
      else if (entries.includes(`${pluginId}/plugin.json`)) target = `${pluginId}/plugin.json`;
      else target = entries.find((e) => /(^|\/)plugin\.json$/.test(e) && !e.includes('..') && !path.isAbsolute(e));
      if (!target) return resolve(null);
      execFile('/usr/bin/unzip', ['-p', zipPath, target], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err2, data) => {
        if (err2) return resolve(null);
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
  });
}

// 下载插件 zip（临时）并解析 plugin.json，带 TTL 缓存；只读不落 store 表
async function fetchPluginManifest(plugin) {
  if (!plugin || !plugin.download || !String(plugin.download).startsWith('https://')) return null;
  if (plugin.status !== 'approved') return null;
  const key = `${plugin.id}|${plugin.version}|${plugin.download}`;
  const hit = manifestCache.get(key);
  if (hit && Date.now() - hit.at < MANIFEST_CACHE_TTL_MS) return hit.payload;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-store-mf-'));
  const zipPath = path.join(tmpDir, 'plugin.zip');
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    const res = await fetch(plugin.download, { signal: ac.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!res || !res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 25 * 1024 * 1024) return null;
    fs.writeFileSync(zipPath, buf);
    const manifest = await readManifestFromZip(zipPath, plugin.id);
    if (manifest) manifestCache.set(key, { at: Date.now(), payload: manifest });
    return manifest;
  } catch {
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/** 上架插件的包信息（含行为清单），供实例确认框与商店详情展示；非上架返回 null */
async function getPluginPackageInfo(id) {
  const plugin = await getPlugin(id);
  if (!plugin || plugin.status !== 'approved') return null;
  const manifest = await fetchPluginManifest(plugin);
  const behavior = {};
  if (manifest) {
    behavior.pages = Array.isArray(manifest.pages) ? manifest.pages : [];
    behavior.slots = Array.isArray(manifest.slots) ? manifest.slots : [];
    behavior.routes = Array.isArray(manifest.routes) ? manifest.routes : [];
    behavior.cron = Array.isArray(manifest.cron) ? manifest.cron : [];
    behavior.themes = Array.isArray(manifest.themes) ? manifest.themes : [];
    behavior.hooks = manifest.hooks && typeof manifest.hooks === 'object' ? manifest.hooks : {};
  }
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    author: plugin.authorNickname || plugin.author || plugin.authorUsername || '',
    authorUsername: plugin.authorUsername || '',
    authorNickname: plugin.authorNickname || plugin.authorUsername || '',
    description: plugin.description || '',
    longDescription: plugin.longDescription || '',
    permissions: plugin.permissions || [],
    tags: plugin.tags || [],
    screenshots: plugin.screenshots || [],
    download: plugin.download,
    sha256: plugin.sha256 || '',
    behavior,
  };
}

/** 按访问者终端 IP 查询其登录过的实例（弱关联：IP + 设备码 + 域名） */
async function listInstallTargets(clientIp) {
  if (!clientIp) return [];
  const res = await q(
    `SELECT domain, device_id,
            bool_or(is_admin) AS is_admin,
            max(event_time) AS last_login,
            count(*)::int AS logins
     FROM login_reports
     WHERE event = 'login' AND client_ip = $1
       AND event_time > now() - interval '90 days'
       AND domain IS NOT NULL AND domain <> ''
     GROUP BY domain, device_id
     ORDER BY last_login DESC`,
    [clientIp]
  );
  return res.rows.map((r) => ({
    domain: r.domain,
    deviceId: r.device_id || '',
    isAdmin: r.is_admin === true,
    lastLogin: iso(r.last_login),
    logins: Number(r.logins || 0),
  }));
}

module.exports = {
  init,
  ensureSchema,
  listPlugins,
  getPlugin,
  canViewPlugin,
  canSeePending,
  createPlugin,
  updatePlugin,
  reviewPlugin,
  incrementInstall,
  listRatings,
  getUserRating,
  upsertRating,
  deleteRating,
  createRatingReply,
  deleteRatingReply,
  listRelated,
  publicView,
  toLauncherManifest,
  buildBloretInstallUrl,
  toStoreProposePayload,
  validatePluginId,
  isHttpsUrl,
  clearAllData,
  getPluginPackageInfo,
  listInstallTargets,
  DEMO_PLUGINS,
};
