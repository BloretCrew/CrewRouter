'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gemini = require('../gemini');

test('Gemini request maps system, tools, tool choice and generation config', () => {
  const ir = gemini.decodeRequest({
    systemInstruction: { parts: [{ text: 'be strict' }] },
    contents: [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'weather', args: { city: 'SZ' } } }] },
      { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'weather', response: { result: 'sunny' } } }] }
    ],
    tools: [{
      functionDeclarations: [{
        name: 'weather',
        description: 'weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
      }]
    }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['weather'] } },
    generationConfig: {
      maxOutputTokens: 64,
      temperature: 0.2,
      topK: 40,
      stopSequences: ['END'],
      responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties: { answer: { type: 'string' } } },
      thinkingConfig: { thinkingBudget: 1024, includeThoughts: true }
    },
    safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
    unknownVendor: { keep: true }
  });

  assert.equal(ir.messages[0].role, 'system');
  assert.equal(ir.messages[1].blocks[0].text, 'hi');
  assert.equal(ir.messages[2].blocks[0].type, 'tool_call');
  assert.equal(ir.messages[2].blocks[0].id, 'c1');
  assert.equal(ir.messages[3].blocks[0].type, 'tool_result');
  assert.equal(ir.messages[3].blocks[0].name, 'weather');
  assert.equal(ir.parameters.maxTokens, 64);
  assert.equal(ir.parameters.topK, 40);
  assert.deepEqual(ir.parameters.stop, ['END']);
  assert.equal(ir.parameters.responseSchema.properties.answer.type, 'string');
  assert.equal(ir.tools[0].name, 'weather');
  assert.deepEqual(ir.toolChoice, { type: 'function', function: { name: 'weather' } });
  assert.deepEqual(ir.passthrough.gemini.unknownVendor, { keep: true });

  const body = gemini.encodeRequest(ir);
  assert.equal(body.systemInstruction.parts[0].text, 'be strict');
  assert.equal(body.contents[1].parts[0].functionCall.id, 'c1');
  assert.equal(body.contents[2].parts[0].functionResponse.name, 'weather');
  assert.equal(body.tools[0].functionDeclarations[0].parameters.type, 'OBJECT');
  assert.equal(body.toolConfig.functionCallingConfig.mode, 'ANY');
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 1024);
  assert.deepEqual(body.safetySettings, [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }]);
  assert.deepEqual(body.unknownVendor, { keep: true });
});

test('Gemini response maps thought signatures, tool calls and usage', () => {
  const ir = gemini.decodeResponse({
    responseId: 'g1',
    modelVersion: 'gemini-test',
    candidates: [{
      index: 0,
      content: {
        role: 'model',
        parts: [
          { text: 'thinking', thought: true },
          { text: 'answer', thoughtSignature: 'sig-text' },
          { functionCall: { id: 'c2', name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'sig-call' }
        ]
      },
      finishReason: 'STOP',
      safetyRatings: [{ category: 'HARM_CATEGORY_HARASSMENT', probability: 'NEGLIGIBLE' }]
    }],
    usageMetadata: {
      promptTokenCount: 3,
      candidatesTokenCount: 4,
      thoughtsTokenCount: 2,
      totalTokenCount: 9,
      cachedContentTokenCount: 1
    }
  });

  assert.equal(ir.finishReason, 'tool_calls');
  assert.equal(ir.message.blocks[0].type, 'thinking');
  assert.equal(ir.message.blocks[0].text, undefined);
  assert.equal(ir.message.blocks[1].signature, 'sig-text');
  assert.equal(ir.message.blocks[2].id, 'c2');
  assert.equal(ir.message.blocks[2].signature, 'sig-call');
  assert.equal(ir.usage.outputTokens, 6);
  assert.equal(ir.usage.reasoningTokens, 2);
  assert.equal(ir.usage.cachedInputTokens, 1);
  assert.equal(ir.passthrough.gemini.candidate.safetyRatings.length, 1);

  const body = gemini.encodeResponse(ir);
  assert.equal(body.candidates[0].finishReason, 'STOP');
  assert.equal(body.candidates[0].content.parts[0].thought, true);
  assert.equal(body.candidates[0].content.parts[1].thoughtSignature, 'sig-text');
  assert.equal(body.candidates[0].content.parts[2].functionCall.name, 'lookup');
  assert.equal(body.candidates[0].safetyRatings.length, 1);
  assert.equal(body.usageMetadata.thoughtsTokenCount, 2);
});

test('Gemini finish reasons and prompt blocking map to IR', () => {
  assert.equal(gemini.decodeResponse({ candidates: [{ finishReason: 'MAX_TOKENS' }] }).finishReason, 'length');
  assert.equal(gemini.decodeResponse({ candidates: [{ finishReason: 'SAFETY' }] }).finishReason, 'content_filter');
  assert.equal(gemini.decodeResponse({ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }).finishReason, 'error');
  const blocked = gemini.decodeResponse({ promptFeedback: { blockReason: 'SAFETY' } });
  assert.equal(blocked.finishReason, 'content_filter');
  assert.equal(blocked.message, null);
});

test('Gemini streaming maps chunk parts and final usage', () => {
  const delta = gemini.decodeStreamEvent({
    candidates: [{ content: { role: 'model', parts: [{ text: 'a' }, { text: 't', thought: true }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
  });
  assert.equal(delta.delta.blocks[0].text, 'a');
  assert.equal(delta.delta.blocks[1].type, 'thinking');
  assert.equal(delta.usage.outputTokens, 1);

  const finish = gemini.decodeStreamEvent({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }] });
  assert.equal(finish.finishReason, 'stop');
  const chunk = gemini.encodeStreamEvent({ delta: { blocks: [{ type: 'text', text: 'x' }] }, id: 'r', model: 'm' });
  assert.equal(chunk.candidates[0].content.parts[0].text, 'x');
  assert.equal(chunk.responseId, 'r');
});

test('Gemini media parts use inlineData and fileData', () => {
  const ir = gemini.decodeRequest({
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/png', data: 'AA==' } },
        { inlineData: { mimeType: 'application/pdf', data: 'BB==' } },
        { fileData: { mimeType: 'video/mp4', fileUri: 'gs://bucket/v.mp4' } }
      ]
    }]
  });
  assert.equal(ir.messages[0].blocks[0].mediaType, 'image');
  assert.equal(ir.messages[0].blocks[1].mediaType, 'document');
  assert.equal(ir.messages[0].blocks[2].mediaType, 'video');
  const body = gemini.encodeRequest(ir);
  assert.equal(body.contents[0].parts[0].inlineData.mimeType, 'image/png');
  assert.equal(body.contents[0].parts[2].fileData.fileUri, 'gs://bucket/v.mp4');
});
