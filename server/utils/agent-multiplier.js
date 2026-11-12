'use strict';

/**
 * 模型倍率草案的解析、换算与批量写入。
 *
 * 计费口径（沿用 billing.js）：
 *   1 积分 = 1,000,000 加权 Token
 *   weighted = (非图片输入 + 图片输入 × image_ratio + 缓存输入 × 0.1 + 输出) × model_multiplier
 *
 * 倍率换算：
 *   new_multiplier = 上游每百万 Token 价格 × 加价系数 × 汇率
 *
 * 本模块只处理 model_multiplier，不修改 completion_multiplier、价格列或计费公式。
 */

const MAX_BATCH = 100;
const MIN_MULTIPLIER = 0.0001;
const MAX_MULTIPLIER = 10000;
const MULTIPLIER_SCALE = 10000;
const DEFAULT_POINTS_CURRENCY = 'CNY';
const BASIS_VALUES = new Set(['input', 'output', 'single']);
const PRICE_UNITS = new Set(['per_1k', 'per_1m']);

const CURRENCY_ALIASES = new Map([
  ['CNY', 'CNY'], ['RMB', 'CNY'], ['￥', 'CNY'], ['¥', 'CNY'], ['人民币', 'CNY'], ['元', 'CNY'],
  ['USD', 'USD'], ['US$', 'USD'], ['$', 'USD'], ['美元', 'USD'],
  ['EUR', 'EUR'], ['€', 'EUR'], ['欧元', 'EUR'],
  ['JPY', 'JPY'], ['円', 'JPY'], ['日元', 'JPY'],
  ['GBP', 'GBP'], ['£', 'GBP'], ['英镑', 'GBP'],
  ['HKD', 'HKD'], ['港币', 'HKD'], ['港元', 'HKD'],
  ['TWD', 'TWD'], ['新台币', 'TWD'],
  ['KRW', 'KRW'], ['韩元', 'KRW'],
  ['SGD', 'SGD'], ['新加坡元', 'SGD']
]);

function round4(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return NaN;
  return Math.round((number + Number.EPSILON) * MULTIPLIER_SCALE) / MULTIPLIER_SCALE;
}

function normalizeCurrency(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  const alias = CURRENCY_ALIASES.get(raw) || CURRENCY_ALIASES.get(raw.toUpperCase());
  if (alias) return alias;
  const upper = raw.toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : '';
}

function parsePositiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseMultiplier(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const rounded = round4(number);
  if (rounded < MIN_MULTIPLIER || rounded > MAX_MULTIPLIER) return null;
  return rounded;
}

function normalizeRef(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function normalizeModel(row) {
  return {
    id: String(row.id),
    name: row.name || '',
    alias: row.alias || '',
    upstreamModelId: row.upstream_model_id || '',
    provider: row.provider || '',
    providerName: row.provider_name || row.provider || '',
    providerEnabled: row.provider_enabled !== false,
    enabled: row.enabled === true,
    currentMultiplier: Number(row.model_multiplier || 1),
    inputPrice: Number(row.input_price_per_1k_tokens || 0),
    outputPrice: Number(row.output_price_per_1k_tokens || 0),
    cachedOutputPrice: Number(row.cached_output_price_per_1k_tokens || 0)
  };
}

async function loadPointsCurrency(db) {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'billing_points_currency' LIMIT 1");
    let value = result.rows[0]?.value;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch (_) { /* 纯字符串原样使用 */ }
    }
    return normalizeCurrency(value) || DEFAULT_POINTS_CURRENCY;
  } catch (_) {
    return DEFAULT_POINTS_CURRENCY;
  }
}

async function loadModelsForDraft(db) {
  const result = await db.query(
    `SELECT m.id, m.name, m.alias, m.upstream_model_id, m.provider, m.enabled,
            m.model_multiplier, m.input_price_per_1k_tokens, m.output_price_per_1k_tokens,
            m.cached_output_price_per_1k_tokens,
            p.name AS provider_name, p.enabled AS provider_enabled
     FROM models m
     LEFT JOIN providers p ON p.id = m.provider`
  );
  return result.rows.map(normalizeModel);
}

function resolveModel(models, item) {
  const provider = String(item.provider || '').trim();
  const scoped = provider ? models.filter(model => model.provider === provider) : models;
  const exactId = String(item.model_id || '').trim();
  if (exactId) {
    const found = models.find(model => model.id === exactId);
    if (found) return { model: found };
    return { error: 'model_not_found' };
  }
  const ref = String(item.model_ref || '').trim();
  if (!ref) return { error: 'model_ref_required' };
  const normalized = normalizeRef(ref);
  const byId = scoped.filter(model => model.id === ref);
  if (byId.length === 1) return { model: byId[0] };
  if (byId.length > 1) return { error: 'ambiguous_model', candidates: byId };
  const byAlias = scoped.filter(model => normalizeRef(model.alias) === normalized);
  if (byAlias.length === 1) return { model: byAlias[0] };
  if (byAlias.length > 1) return { error: 'ambiguous_model', candidates: byAlias };
  const byName = scoped.filter(model => normalizeRef(model.name) === normalized);
  if (byName.length === 1) return { model: byName[0] };
  if (byName.length > 1) return { error: 'ambiguous_model', candidates: byName };
  const byUpstreamExact = scoped.filter(model => model.upstreamModelId === ref);
  if (byUpstreamExact.length === 1) return { model: byUpstreamExact[0] };
  if (byUpstreamExact.length > 1) return { error: 'ambiguous_model', candidates: byUpstreamExact };
  const byUpstreamLoose = scoped.filter(model => normalizeRef(model.upstreamModelId) === normalized);
  if (byUpstreamLoose.length === 1) return { model: byUpstreamLoose[0] };
  if (byUpstreamLoose.length > 1) return { error: 'ambiguous_model', candidates: byUpstreamLoose };
  return { error: 'model_not_found' };
}

function candidateList(models) {
  return models.slice(0, 10).map(model => ({
    id: model.id,
    name: model.name,
    upstream_model_id: model.upstreamModelId,
    provider: model.provider,
    provider_name: model.providerName
  }));
}

function riskFlags(model, current, next, basis) {
  const flags = [];
  if (!model.enabled) flags.push('disabled_model');
  if (!model.providerEnabled) flags.push('provider_disabled');
  if (current > 0 && (next / current > 5 || next / current < 0.2)) flags.push('large_change');
  // 启动迁移会把旧价格列统一成 1.0；全为 1.0 时不要用它们推断输入/输出价差。
  const priceTableConfigured = !(model.inputPrice === 1 && model.outputPrice === 1 && model.cachedOutputPrice === 1);
  if (priceTableConfigured && basis === 'input' && model.inputPrice > 0 && model.outputPrice > 0
      && model.outputPrice / model.inputPrice > 4) flags.push('output_price_mismatch');
  if (priceTableConfigured && model.inputPrice > 0 && model.cachedOutputPrice > 0) {
    const expectedCache = model.inputPrice * 0.1;
    if (Math.abs(model.cachedOutputPrice - expectedCache) > Math.max(0.000001, model.inputPrice * 0.01)) {
      flags.push('cache_price_mismatch');
    }
  }
  return flags;
}

function computeMultiplier({ sourcePrice, priceUnit, markup, fxRate }) {
  const perMillion = priceUnit === 'per_1k' ? sourcePrice * 1000 : sourcePrice;
  return round4(perMillion * markup * fxRate);
}

/**
 * 把模型原始草案规范化：解析模型引用、按价格重算倍率、收集未匹配项与风险。
 * 不写库。
 */
async function normalizeMultiplierBatch(db, args = {}, options = {}) {
  const requireExpected = options.requireExpected === true;
  const basis = String(args.basis || '').trim();
  if (!BASIS_VALUES.has(basis)) {
    return { ok: false, code: 'basis_required', error: '缺少计价基准 basis（input/output/single）' };
  }
  const markup = parsePositiveNumber(args.markup);
  if (!markup || markup > 100) {
    return { ok: false, code: 'markup_required', error: '缺少有效加价系数 markup（0 < markup ≤ 100）' };
  }
  const currency = normalizeCurrency(args.currency);
  if (!currency) {
    return { ok: false, code: 'currency_required', error: '缺少有效源币种 currency' };
  }
  const defaultFx = args.fx_rate === undefined || args.fx_rate === null || args.fx_rate === ''
    ? null : parsePositiveNumber(args.fx_rate);
  if (args.fx_rate !== undefined && args.fx_rate !== null && args.fx_rate !== '' && !defaultFx) {
    return { ok: false, code: 'invalid_fx_rate', error: '汇率 fx_rate 必须是正数' };
  }
  const changes = Array.isArray(args.changes) ? args.changes : [];
  if (!changes.length || changes.length > MAX_BATCH) {
    return { ok: false, code: 'invalid_batch_size', error: `一次草案需要 1–${MAX_BATCH} 项变更` };
  }

  const pointsCurrency = await loadPointsCurrency(db);
  const models = await loadModelsForDraft(db);
  const results = [];
  const unmatched = [];
  const errors = [];
  const warnings = [];
  const seenModels = new Set();

  for (const item of changes) {
    const refLabel = String(item.model_id || item.model_ref || '').trim();
    if (!refLabel) {
      errors.push({ model_ref: '', reason: 'model_ref_required' });
      continue;
    }
    const resolved = resolveModel(models, item);
    if (!resolved.model) {
      const entry = { model_ref: refLabel, reason: resolved.error || 'model_not_found' };
      if (resolved.candidates) entry.candidates = candidateList(resolved.candidates);
      unmatched.push(entry);
      continue;
    }
    const model = resolved.model;
    if (seenModels.has(model.id)) {
      errors.push({ model_ref: refLabel, model_id: model.id, reason: 'duplicate_model' });
      continue;
    }
    seenModels.add(model.id);
    const itemBasis = String(item.basis || basis).trim();
    if (!BASIS_VALUES.has(itemBasis)) {
      errors.push({ model_ref: refLabel, reason: 'basis_required' });
      continue;
    }
    const price = parsePositiveNumber(item.source_price);
    if (!price) {
      errors.push({ model_ref: refLabel, model_id: model.id, reason: 'missing_price' });
      continue;
    }
    const unit = String(item.price_unit || '').trim();
    if (!PRICE_UNITS.has(unit)) {
      errors.push({ model_ref: refLabel, model_id: model.id, reason: 'price_unit_required' });
      continue;
    }
    const sourceCurrency = normalizeCurrency(item.source_currency || currency);
    if (!sourceCurrency) {
      errors.push({ model_ref: refLabel, model_id: model.id, reason: 'currency_required' });
      continue;
    }
    const itemMarkup = item.markup === undefined || item.markup === null || item.markup === ''
      ? markup : parsePositiveNumber(item.markup);
    if (!itemMarkup || itemMarkup > 100) {
      errors.push({ model_ref: refLabel, model_id: model.id, reason: 'markup_required' });
      continue;
    }
    const fxProvided = item.fx_rate !== undefined && item.fx_rate !== null && item.fx_rate !== '';
    const itemFx = fxProvided ? parsePositiveNumber(item.fx_rate) : defaultFx;
    if (fxProvided && !itemFx) {
      errors.push({ model_ref: refLabel, model_id: model.id, reason: 'invalid_fx_rate' });
      continue;
    }
    const sameCurrency = sourceCurrency === pointsCurrency;
    if (!sameCurrency && !itemFx) {
      errors.push({
        model_ref: refLabel,
        model_id: model.id,
        reason: 'fx_required',
        message: `源币种 ${sourceCurrency} 与积分币种 ${pointsCurrency} 不同，需要汇率 fx_rate`
      });
      continue;
    }
    const fxRate = sameCurrency ? 1 : itemFx;
    const computed = computeMultiplier({ sourcePrice: price, priceUnit: unit, markup: itemMarkup, fxRate });
    if (!Number.isFinite(computed) || computed < MIN_MULTIPLIER || computed > MAX_MULTIPLIER) {
      errors.push({
        model_ref: refLabel,
        model_id: model.id,
        reason: 'multiplier_out_of_range',
        message: `计算出的倍率 ${computed} 超出 ${MIN_MULTIPLIER}–${MAX_MULTIPLIER}`
      });
      continue;
    }
    const proposed = item.new_multiplier === undefined || item.new_multiplier === null || item.new_multiplier === ''
      ? computed : parseMultiplier(item.new_multiplier);
    if (proposed === null) {
      errors.push({ model_ref: refLabel, model_id: model.id, reason: 'invalid_new_multiplier' });
      continue;
    }
    if (Math.abs(proposed - computed) > 0.0001) {
      errors.push({
        model_ref: refLabel,
        model_id: model.id,
        reason: 'multiplier_mismatch',
        message: `新倍率 ${proposed} 与服务端重算结果 ${computed} 不一致`
      });
      continue;
    }
    const current = model.currentMultiplier;
    const expected = requireExpected
      ? parsePositiveNumber(item.expected_current_multiplier)
      : (item.expected_current_multiplier === undefined ? null : parsePositiveNumber(item.expected_current_multiplier));
    if (requireExpected && !expected) {
      errors.push({ model_ref: refLabel, model_id: model.id, reason: 'expected_multiplier_required' });
      continue;
    }
    const stale = expected !== null && Math.abs(expected - current) > 0.0001;
    const deltaPct = current > 0 ? round4(((proposed - current) / current) * 100) : null;
    const flags = riskFlags(model, current, proposed, itemBasis);
    if (stale) flags.push('stale');
    const sourceIds = Array.isArray(item.source_attachment_ids)
      ? [...new Set(item.source_attachment_ids.map(Number).filter(Number.isInteger))].slice(0, 20) : [];
    results.push({
      model_id: model.id,
      model_ref: refLabel,
      name: model.name,
      upstream_model_id: model.upstreamModelId,
      provider: model.provider,
      provider_name: model.providerName,
      enabled: model.enabled,
      provider_enabled: model.providerEnabled,
      basis: itemBasis,
      source_price: price,
      price_unit: unit,
      source_currency: sourceCurrency,
      fx_rate: fxRate,
      markup: itemMarkup,
      current_multiplier: current,
      expected_current_multiplier: expected,
      new_multiplier: proposed,
      delta_pct: deltaPct,
      risk_flags: [...new Set(flags)],
      reason: typeof item.reason === 'string' ? item.reason.slice(0, 500) : '',
      source_attachment_ids: sourceIds,
      stale
    });
  }

  const changed = results.filter(item => Math.abs(item.new_multiplier - item.current_multiplier) > 0.0001);
  const unchanged = results.length - changed.length;
  const staleCount = results.filter(item => item.stale).length;

  return {
    ok: true,
    basis,
    points_currency: pointsCurrency,
    currency,
    fx_rate: defaultFx,
    markup,
    changes: results,
    unmatched,
    errors,
    warnings,
    summary: {
      count: results.length,
      changed: changed.length,
      unchanged,
      stale: staleCount,
      unmatched: unmatched.length,
      errors: errors.length,
      total: results.length + unmatched.length + errors.length
    }
  };
}

function draftProblem(normalized) {
  if (!normalized.ok) return normalized;
  if (normalized.errors.length) {
    return { ok: false, code: 'draft_invalid', error: normalized.errors[0].message || '草案包含无效项', details: normalized.errors };
  }
  if (normalized.unmatched.length) {
    return { ok: false, code: 'unmatched_models', error: '草案包含未匹配的模型', details: normalized.unmatched };
  }
  if (!normalized.changes.length) {
    return { ok: false, code: 'empty_draft', error: '草案没有可执行的变更' };
  }
  if (normalized.changes.some(item => item.stale)) {
    return { ok: false, code: 'stale_multiplier', error: '模型倍率已变化，请重新生成草案', details: normalized.changes.filter(item => item.stale) };
  }
  return { ok: true };
}

/**
 * 在审批事务中执行批量倍率更新。db 必须是已开启事务的客户端。
 */
async function applyMultiplierBatch(db, args) {
  const normalized = await normalizeMultiplierBatch(db, args, { requireExpected: true });
  const problem = draftProblem(normalized);
  if (!problem.ok) {
    const error = new Error(problem.error);
    error.code = problem.code;
    error.details = problem.details;
    throw error;
  }
  const changes = normalized.changes;
  const ids = [...new Set(changes.map(item => item.model_id))].sort();
  const rows = await db.query(
    'SELECT id, model_multiplier FROM models WHERE id = ANY($1::text[]) ORDER BY id FOR NO KEY UPDATE',
    [ids]
  );
  const byId = new Map(rows.rows.map(row => [row.id, Number(row.model_multiplier)]));
  if (byId.size !== ids.length) {
    const error = new Error('模型不存在或已被删除');
    error.code = 'model_not_found';
    throw error;
  }
  const stale = [];
  for (const item of changes) {
    const current = byId.get(item.model_id);
    if (item.expected_current_multiplier === null
        || Math.abs(current - item.expected_current_multiplier) > 0.0001) {
      stale.push({ model_id: item.model_id, expected: item.expected_current_multiplier, current });
    }
  }
  if (stale.length) {
    const error = new Error('模型倍率已变化，请重新生成草案');
    error.code = 'stale_multiplier';
    error.details = stale;
    throw error;
  }
  const toUpdate = changes.filter(item => Math.abs(item.new_multiplier - byId.get(item.model_id)) > 0.0001);
  if (toUpdate.length) {
    const values = [];
    const params = [];
    toUpdate.forEach((item, index) => {
      const base = index * 2;
      values.push(`($${base + 1}::text, $${base + 2}::numeric)`);
      params.push(item.model_id, item.new_multiplier);
    });
    await db.query(
      `UPDATE models AS m
       SET model_multiplier = v.multiplier
       FROM (VALUES ${values.join(',')}) AS v(id, multiplier)
       WHERE m.id = v.id`,
      params
    );
  }
  return {
    updated: toUpdate.length,
    unchanged: changes.length - toUpdate.length,
    changes: changes.map(item => ({
      id: item.model_id,
      name: item.name,
      provider: item.provider,
      old_multiplier: byId.get(item.model_id),
      new_multiplier: item.new_multiplier
    }))
  };
}

function toApprovalPreview(normalized) {
  return {
    type: 'model_multiplier_batch',
    basis: normalized.basis,
    points_currency: normalized.points_currency,
    currency: normalized.currency,
    fx_rate: normalized.fx_rate,
    markup: normalized.markup,
    summary: normalized.summary,
    rows: normalized.changes.map(item => ({
      model_id: item.model_id,
      name: item.name,
      upstream_model_id: item.upstream_model_id,
      provider: item.provider,
      provider_name: item.provider_name,
      current_multiplier: item.current_multiplier,
      proposed_multiplier: item.new_multiplier,
      delta_pct: item.delta_pct,
      basis: item.basis,
      source_price: item.source_price,
      price_unit: item.price_unit,
      source_currency: item.source_currency,
      fx_rate: item.fx_rate,
      markup: item.markup,
      risk_flags: item.risk_flags,
      reason: item.reason,
      source_attachment_ids: item.source_attachment_ids
    })),
    unmatched: normalized.unmatched,
    errors: normalized.errors,
    warnings: normalized.warnings,
    sources: []
  };
}

module.exports = {
  MAX_BATCH,
  MIN_MULTIPLIER,
  MAX_MULTIPLIER,
  DEFAULT_POINTS_CURRENCY,
  round4,
  normalizeCurrency,
  loadPointsCurrency,
  normalizeMultiplierBatch,
  draftProblem,
  applyMultiplierBatch,
  toApprovalPreview
};
