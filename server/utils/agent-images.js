'use strict';

const IMAGE_SIZES = Object.freeze(['1024x1024', '1024x1792', '1792x1024']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TEST_IMAGE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function assertImageModel(model) {
  if (!model) return { ok: false, status: 404, error: '模型不存在或已禁用' };
  if (model.output_kind !== 'image') return { ok: false, status: 400, error: '该模型不是图像模型' };
  return { ok: true };
}

function assertImageBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    return { ok: false, status: 502, error: '上游没有返回图片数据' };
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, status: 413, error: '图片超过 8 MB' };
  }
  return { ok: true };
}

function assertImageSize(size) {
  const value = String(size || '1024x1024');
  if (!IMAGE_SIZES.includes(value)) return { ok: false, status: 400, error: '尺寸不受支持' };
  return { ok: true, size: value };
}

function sniffMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

function imageUsageTokens(usage) {
  const promptTokens = Number(usage?.prompt_tokens || usage?.input_tokens || 0);
  const completionTokens = Number(usage?.completion_tokens || usage?.output_tokens || 0);
  if (promptTokens + completionTokens > 0) {
    return { promptTokens, completionTokens };
  }
  return { promptTokens: 0, completionTokens: 1000 };
}

function decodeImagePayload(payload) {
  const item = payload?.data?.[0] || payload || {};
  const b64 = item.b64_json || payload?.b64_json;
  if (!b64) return { ok: false, status: 502, error: '上游没有返回图片数据' };
  const bytes = Buffer.from(String(b64), 'base64');
  const check = assertImageBytes(bytes);
  if (!check.ok) return check;
  return { ok: true, bytes, mime: sniffMime(bytes) };
}

function isTestImageModel(model) {
  return model?.id === 'test-image' || model?.upstream_model_id === 'test-image';
}

async function insertImage(db, { userId, modelId, prompt, size, mime, bytes }) {
  const check = assertImageBytes(bytes);
  if (!check.ok) return check;
  const result = await db.query(
    `INSERT INTO agent_images (user_id, model_id, prompt, size, mime, bytes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
    [userId, modelId, prompt, size, mime || sniffMime(bytes), bytes]
  );
  return { ok: true, id: result.rows[0].id, created_at: result.rows[0].created_at };
}

async function getImageContent(db, id, userId) {
  const result = await db.query(
    `SELECT id, user_id, mime, bytes FROM agent_images WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return result.rows[0] || null;
}

module.exports = {
  IMAGE_SIZES,
  MAX_IMAGE_BYTES,
  TEST_IMAGE_PNG,
  assertImageModel,
  assertImageBytes,
  assertImageSize,
  sniffMime,
  imageUsageTokens,
  decodeImagePayload,
  isTestImageModel,
  insertImage,
  getImageContent
};
