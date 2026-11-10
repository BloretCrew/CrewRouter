'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const interactions = require('../interactions');

test('Interactions input accepts strings, content blocks and steps', () => {
  const stringIr = interactions.decodeRequest({ model: 'm', input: 'hello' });
  assert.equal(stringIr.messages[0].blocks[0].text, 'hello');

  const contentIr = interactions.decodeRequest({
    model: 'm',
    input: [{ type: 'text', text: 'one' }, { type: 'image', mime_type: 'image/png', data: 'AA==' }]
  });
  assert.equal(contentIr.messages[0].blocks[0].text, 'one');
  assert.equal(contentIr.messages[0].blocks[1].mediaType, 'image');

  const stepIr = interactions.decodeRequest({
    model: 'm',
    input: [
      { type: 'function_call', id: 'c1', name: 'f', arguments: { x: 1 } },
      { type: 'function_result', call_id: 'c1', name: 'f', result: { ok: true } }
    ]
  });
  assert.equal(stepIr.messages[0].blocks[0].type, 'tool_call');
  assert.equal(stepIr.messages[1].blocks[0].type, 'tool_result');
  assert.equal(stepIr.messages[1].blocks[0].name, 'f');
  assert.deepEqual(stepIr.messages[1].blocks[0].result, { ok: true });
});

test('Interactions tools, generation config and response format map to IR', () => {
  const ir = interactions.decodeRequest({
    model: 'm',
    system_instruction: 'be strict',
    tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } }],
    generation_config: {
      max_output_tokens: 32,
      stop_sequences: ['END'],
      seed: 7,
      thinking_level: 'high',
      tool_choice: 'any'
    },
    response_format: { type: 'text', mime_type: 'application/json', schema: { type: 'object' } }
  });
  assert.equal(ir.messages[0].role, 'system');
  assert.equal(ir.parameters.maxTokens, 32);
  assert.deepEqual(ir.parameters.stop, ['END']);
  assert.equal(ir.parameters.seed, 7);
  assert.equal(ir.parameters.reasoningEffort, 'high');
  assert.equal(ir.tools[0].name, 'f');
  assert.equal(ir.toolChoice, 'required');
  assert.equal(ir.parameters.responseMimeType, 'application/json');
});

test('Interactions response builds thought, model_output and function_call steps', () => {
  const body = interactions.encodeResponse({
    id: 'v1_test',
    model: 'm',
    finishReason: 'tool_calls',
    usage: { inputTokens: 3, outputTokens: 5, reasoningTokens: 2 },
    message: {
      blocks: [
        { type: 'thinking', thinking: 'reason', signature: 'sig' },
        { type: 'text', text: 'answer' },
        { type: 'tool_call', id: 'c1', name: 'f', input: { x: 1 } }
      ]
    }
  });
  assert.equal(body.object, 'interaction');
  assert.equal(body.status, 'requires_action');
  assert.equal(body.steps[0].type, 'thought');
  assert.equal(body.steps[0].signature, 'sig');
  assert.equal(body.steps[1].type, 'model_output');
  assert.equal(body.steps[1].content[0].text, 'answer');
  assert.equal(body.steps[2].type, 'function_call');
  assert.deepEqual(body.steps[2].arguments, { x: 1 });
  assert.equal(body.usage.total_input_tokens, 3);
  assert.equal(body.usage.total_output_tokens, 3);
  assert.equal(body.usage.total_thought_tokens, 2);
});

test('Interactions stream events map to IR and back', () => {
  const created = interactions.decodeStreamEvent({
    event_type: 'interaction.created',
    interaction: { id: 'v1_x', status: 'in_progress', model: 'm' }
  });
  assert.equal(created.id, 'v1_x');

  const text = interactions.decodeStreamEvent({
    event_type: 'step.delta',
    index: 1,
    delta: { type: 'text', text: 'hi' }
  });
  assert.equal(text.delta.blocks[0].text, 'hi');

  const args = interactions.decodeStreamEvent({
    event_type: 'step.delta',
    index: 2,
    delta: { type: 'arguments_delta', arguments: '{"x":' }
  });
  assert.equal(args.delta.blocks[0].type, 'tool_call_delta');

  const completed = interactions.decodeStreamEvent({
    event_type: 'interaction.completed',
    interaction: { id: 'v1_x', status: 'completed', usage: { total_input_tokens: 2, total_output_tokens: 1, total_tokens: 3 } }
  });
  assert.equal(completed.finishReason, 'stop');
  assert.equal(completed.usage.inputTokens, 2);

  const encoded = interactions.encodeStreamEvent({
    delta: { blocks: [{ type: 'text', text: 'x' }] },
    index: 1
  });
  assert.equal(encoded.event_type, 'step.delta');
  assert.equal(encoded.delta.text, 'x');
});

test('Interactions usage keeps thoughts separate from candidates', () => {
  const usage = interactions.decodeUsage({
    total_input_tokens: 10,
    total_output_tokens: 4,
    total_thought_tokens: 3,
    total_cached_tokens: 2,
    total_tokens: 17
  });
  assert.equal(usage.outputTokens, 7);
  assert.equal(usage.candidatesTokens, 4);
  assert.equal(usage.reasoningTokens, 3);
  const back = interactions.encodeUsage(usage);
  assert.equal(back.total_output_tokens, 4);
  assert.equal(back.total_thought_tokens, 3);
  assert.equal(back.total_tokens, 17);
});
