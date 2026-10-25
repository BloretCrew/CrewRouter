'use strict';
const crypto = require('node:crypto');
function invalid(message, status = 400) { return Object.assign(new Error(message), { status }); }
function alias(body, camel, snake, { text = false } = {}) {
  for (const key of [camel, snake]) {
    const value = body[key];
    if (value === undefined) continue;
    if (text ? value !== null && typeof value !== 'string' : !['string', 'number'].includes(typeof value)) {
      throw invalid('兑换码参数别名类型无效');
    }
  }
  if (body[camel] !== undefined && body[snake] !== undefined
      && (body[camel] === null || body[snake] === null
        ? body[camel] !== body[snake] : String(body[camel]) !== String(body[snake]))) {
    throw invalid('兑换码参数别名值冲突');
  }
  return body[camel] !== undefined ? body[camel] : body[snake];
}
function money(value, maxWhole, allowZero = false) {
  if (!['string', 'number'].includes(typeof value) || String(value).length > 32 || !/^\d+(?:\.\d{1,4})?$/.test(String(value))) throw invalid('金额或手续费格式无效，最多支持4位小数');
  const [whole, fraction = ''] = String(value).split('.');
  const units = BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
  if (units > maxWhole || (allowZero ? units < 0n : units <= 0n)) throw invalid('金额或手续费超出允许范围');
  return `${units / 10000n}.${String(units % 10000n).padStart(4, '0')}`;
}
function integer(value, min, max, fallback) {
  if (value === undefined || value === null) value = fallback;
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value))) throw invalid('兑换码数量或次数必须为整数');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw invalid('兑换码数量或次数超出允许范围');
  return number;
}
function normalizeCreation(body, { manual = false } = {}) {
  const amount = money(body.amount, 9999999999n);
  const maxUses = integer(alias(body, 'maxUses', 'max_uses'), 0, 2147483647, 1);
  const count = manual ? 1 : integer(body.count, 1, 1000);
  if (body.refundable !== undefined && typeof body.refundable !== 'boolean') throw invalid('可退款属性必须为布尔值');
  const refundable = body.refundable === true;
  const fee = alias(body, 'feeRate', 'fee_rate');
  const feeRate = money(fee === undefined || fee === null ? 0 : fee, 99999n, true);
  const batchName = alias(body, 'batchName', 'batch_name', { text: true });
  if (batchName !== undefined && batchName !== null && (typeof batchName !== 'string' || batchName.length > 255)) throw invalid('批次名称最多255个字符');
  const expiresAt = alias(body, 'expiresAt', 'expires_at', { text: true });
  if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '' && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) throw invalid('兑换码有效期格式无效');
  let codes;
  if (manual) {
    if (typeof body.code !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(body.code.trim())) throw invalid('兑换码须为1至32位字母、数字、下划线或连字符');
    codes = [body.code.trim().toUpperCase()];
  } else {
    const prefix = body.prefix === undefined || body.prefix === null ? '' : body.prefix;
    if (typeof prefix !== 'string' || !/^[A-Za-z0-9_-]{0,16}$/.test(prefix)) throw invalid('兑换码前缀最多16位字母、数字、下划线或连字符');
    const generated = new Set();
    while (generated.size < count) generated.add(prefix.toUpperCase() + crypto.randomBytes(8).toString('hex').toUpperCase());
    codes = [...generated];
  }
  return { amount, maxUses, count, refundable, feeRate: refundable ? feeRate : '0.0000', batchName: batchName || null, expiresAt: expiresAt || null, codes };
}
async function createCodes(pool, body, creator, options) {
  const normalized = normalizeCreation(body, options);
  const params = [];
  const values = normalized.codes.map((code, index) => {
    const offset = index * 8;
    params.push(code, normalized.amount, normalized.maxUses, normalized.expiresAt, normalized.batchName, creator, normalized.refundable, normalized.feeRate);
    return `(${Array.from({ length: 8 }, (_, j) => '$' + (offset + j + 1)).join(',')})`;
  });
  const result = await pool.query(`INSERT INTO redemption_codes (code, amount, max_uses, expires_at, batch_name, created_by, refundable, fee_rate) VALUES ${values.join(',')} RETURNING *`, params);
  return result.rows;
}
function normalizeIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000) throw invalid('请选择1至1000个有效兑换码');
  return [...new Set(ids.map(id => integer(id, 1, 2147483647)))].sort((a, b) => a - b);
}
async function deleteUnusedCodes(pool, ids) {
  ids = normalizeIds(ids);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT id, used_count FROM redemption_codes WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [ids]);
    if (locked.rows.length !== ids.length) throw invalid('部分兑换码不存在', 404);
    if (locked.rows.some(row => row.used_count !== 0)) throw invalid('已使用或计数异常的兑换码不可删除', 409);
    const related = await client.query(`SELECT EXISTS(SELECT 1 FROM redemption_code_uses WHERE code_id = ANY($1::int[])) OR EXISTS(SELECT 1 FROM user_code_balances WHERE code_id = ANY($1::int[])) AS present`, [ids]);
    if (related.rows[0].present) throw invalid('有使用历史或余额明细的兑换码不可删除', 409);
    await client.query('DELETE FROM redemption_codes WHERE id = ANY($1::int[])', [ids]);
    await client.query('COMMIT');
    return ids.length;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
module.exports = { normalizeCreation, createCodes, deleteUnusedCodes };
