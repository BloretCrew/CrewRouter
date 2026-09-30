'use strict';

const assert = require('assert');
const {
  assertImageModel,
  assertImageBytes,
  TEST_IMAGE_PNG,
  MAX_IMAGE_BYTES,
  sniffMime,
  imageUsageTokens,
  insertImage,
  getImageContent
} = require('../utils/agent-images');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log('  PASS', name);
}

function memoryDb() {
  const images = [];
  return {
    images,
    async query(sql, params) {
      if (sql.includes('INSERT INTO agent_images')) {
        const row = {
          id: images.length + 1,
          user_id: params[0],
          model_id: params[1],
          prompt: params[2],
          size: params[3],
          mime: params[4],
          bytes: params[5]
        };
        images.push(row);
        return { rows: [{ id: row.id, created_at: '2026-09-30T00:00:00.000Z' }] };
      }
      if (sql.includes('FROM agent_images') && sql.includes('user_id = $2')) {
        const row = images.find(item => String(item.id) === String(params[0]) && String(item.user_id) === String(params[1]));
        return { rows: row ? [row] : [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }
  };
}

async function main() {
  assert.strictEqual(assertImageModel({ id: 'chat-model', output_kind: 'chat' }).status, 400);
  assert.strictEqual(assertImageModel(null).status, 404);
  assert.strictEqual(assertImageModel({ id: 'test-image', output_kind: 'image' }).ok, true);
  ok('non-image models are rejected');

  assert.strictEqual(assertImageBytes(Buffer.alloc(MAX_IMAGE_BYTES + 1)).status, 413);
  ok('oversized images are rejected');

  assert.strictEqual(sniffMime(TEST_IMAGE_PNG), 'image/png');
  assert.ok(TEST_IMAGE_PNG.length < 1024);
  assert.deepStrictEqual(imageUsageTokens(null), { promptTokens: 0, completionTokens: 1000 });
  assert.deepStrictEqual(imageUsageTokens({ prompt_tokens: 2, completion_tokens: 3 }), { promptTokens: 2, completionTokens: 3 });
  ok('test-image is a small png and usage falls back to 1000 completion tokens');

  const db = memoryDb();
  const saved = await insertImage(db, {
    userId: 7,
    modelId: 'test-image',
    prompt: 'a dot',
    size: '1024x1024',
    mime: 'image/png',
    bytes: TEST_IMAGE_PNG
  });
  assert.strictEqual(saved.ok, true);
  const own = await getImageContent(db, saved.id, 7);
  const other = await getImageContent(db, saved.id, 8);
  assert.ok(own);
  assert.strictEqual(own.bytes.length, TEST_IMAGE_PNG.length);
  assert.strictEqual(other, null);
  ok('stored images can be read only by their creator');

  const tooBig = await insertImage(db, {
    userId: 7,
    modelId: 'test-image',
    prompt: 'big',
    size: '1024x1024',
    mime: 'image/png',
    bytes: Buffer.alloc(MAX_IMAGE_BYTES + 1)
  });
  assert.strictEqual(tooBig.ok, false);
  assert.strictEqual(db.images.length, 1);
  ok('oversized bytes are not stored');

  console.log(`\n${passed} assertions passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
