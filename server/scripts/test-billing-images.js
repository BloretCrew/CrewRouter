'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateCost, countImageBlocks, estimateImageTokens, DEFAULT_IMAGE_TOKEN_ESTIMATE } = require('../utils/billing');
const { normalizeUsageTokens } = require('../utils/token-normalize');

test('image_ratio=1 keeps the legacy weighted token formula', () => {
  const result = calculateCost(
    { model_multiplier: 1, image_ratio: 1 },
    { promptTokens: 1000, completionTokens: 100, cachedTokens: 0, imageTokens: 200 }
  );
  assert.equal(result.weightedTokens, 1100);
  assert.equal(result.breakdown.imageTokens, 200);
});

test('image_ratio only amplifies the image portion of prompt tokens', () => {
  const result = calculateCost(
    { model_multiplier: 1, image_ratio: 2 },
    { promptTokens: 1000, completionTokens: 0, cachedTokens: 0, imageTokens: 200 }
  );
  assert.equal(result.weightedTokens, 1200);
  assert.equal(result.breakdown.nonImageInputTokens, 800);
  assert.equal(result.breakdown.imageTokens, 200);
  assert.equal(result.breakdown.imageRatio, 2);
});

test('image token weighting respects cache discount and model multiplier', () => {
  const result = calculateCost(
    { model_multiplier: 1.5, image_ratio: 2 },
    { promptTokens: 1000, completionTokens: 100, cachedTokens: 400, imageTokens: 200 }
  );
  // (600 - 200) + 200*2 + 400*0.1 + 100 = 940; ×1.5 = 1410
  assert.equal(result.weightedTokens, 1410);
});

test('missing or zero image_ratio falls back to 1.0', () => {
  for (const ratio of [undefined, 0, -1, Number.NaN]) {
    const result = calculateCost(
      { model_multiplier: 1, image_ratio: ratio },
      { promptTokens: 500, completionTokens: 0, cachedTokens: 0, imageTokens: 100 }
    );
    assert.equal(result.weightedTokens, 500, `ratio=${ratio}`);
    assert.equal(result.breakdown.imageRatio, 1);
  }
});

test('reported image tokens are capped at uncached input tokens', () => {
  const result = calculateCost(
    { model_multiplier: 1, image_ratio: 3 },
    { promptTokens: 100, completionTokens: 0, cachedTokens: 0, imageTokens: 500 }
  );
  assert.equal(result.breakdown.imageTokens, 100);
  assert.equal(result.weightedTokens, 300);
});

test('image token estimate counts protocol-specific image blocks', () => {
  const bodies = [
    { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AA==' } }] }] },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/a.png' } }] }] },
    { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] }] },
    { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] }] }
  ];
  for (const [index, body] of bodies.entries()) {
    assert.equal(countImageBlocks(body), 1, `body ${index}`);
    assert.equal(estimateImageTokens(body), DEFAULT_IMAGE_TOKEN_ESTIMATE, `body ${index}`);
  }
  assert.equal(countImageBlocks({ contents: [{ parts: [{ inlineData: { mimeType: 'application/pdf', data: 'AA==' } }] }] }), 0);
});

test('calculateCost estimates image tokens when the upstream omits them', () => {
  const body = { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AA==' } }] }] };
  const result = calculateCost(
    { model_multiplier: 1, image_ratio: 2, image_token_estimate: 100 },
    { promptTokens: 1000, completionTokens: 0, cachedTokens: 0, imageTokens: 0 },
    body
  );
  assert.equal(result.breakdown.imageTokens, 100);
  assert.equal(result.weightedTokens, 1100);
});

test('normalizeUsageTokens extracts image tokens from provider usage details', () => {
  const openai = normalizeUsageTokens({
    prompt_tokens: 1000,
    completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 0, image_tokens: 250 }
  }, 'openai');
  assert.equal(openai.imageTokens, 250);

  const gemini = normalizeUsageTokens({
    promptTokenCount: 1000,
    candidatesTokenCount: 10,
    promptTokensDetails: [
      { modality: 'IMAGE', tokenCount: 300 },
      { modality: 'TEXT', tokenCount: 700 }
    ]
  }, 'gemini');
  assert.equal(gemini.imageTokens, 300);

  const anthropic = normalizeUsageTokens({ input_tokens: 100, output_tokens: 10, image_tokens: 40 }, 'anthropic');
  assert.equal(anthropic.imageTokens, 40);
});
