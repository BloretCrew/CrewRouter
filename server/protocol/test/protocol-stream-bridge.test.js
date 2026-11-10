'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStreamWriter } = require('../stream-writers');
const { createSSEParser } = require('../sse');

async function collect(dialect, events, options = {}) {
  let output = '';
  const writer = createStreamWriter(dialect, {
    model: 'test-model',
    id: 'id-1',
    alt: options.alt || 'sse',
    write: async (data) => { output += data; }
  });
  if (writer.start) await writer.start();
  for (const event of events) await writer.push(event);
  await writer.end({ finishReason: 'tool_calls', usage: { inputTokens: 3, outputTokens: 4, reasoningTokens: 1 } });
  return { output, writer };
}

function frames(output) {
  const parser = createSSEParser();
  return parser.push(output).concat(parser.end());
}

const events = [
  { delta: { blocks: [{ type: 'thinking', thinking: 'plan' }] } },
  { delta: { blocks: [{ type: 'text', text: 'hello' }] } },
  { delta: { blocks: [{ type: 'tool_call', id: 'c1', name: 'f', input: { x: 1 }, argumentsText: '{"x":1}' }] } }
];

test('OpenAI writer emits content, reasoning, tool calls, usage and [DONE]', async () => {
  const { output } = await collect('openai', events);
  assert.match(output, /"reasoning_content":"plan"/);
  assert.match(output, /"content":"hello"/);
  assert.match(output, /"tool_calls":\[\{"index":0,"id":"c1"/);
  assert.match(output, /"finish_reason":"tool_calls"/);
  assert.match(output, /"prompt_tokens":3/);
  assert.match(output, /data: \[DONE\]/);
});

test('Anthropic writer emits a complete message lifecycle', async () => {
  const { output } = await collect('anthropic', events);
  const names = frames(output).map(frame => frame.event);
  assert.equal(names[0], 'message_start');
  assert.ok(names.includes('content_block_start'));
  assert.ok(names.includes('content_block_delta'));
  assert.ok(names.includes('content_block_stop'));
  assert.equal(names.at(-2), 'message_delta');
  assert.equal(names.at(-1), 'message_stop');
  assert.match(output, /"type":"tool_use"/);
  assert.match(output, /"stop_reason":"tool_use"/);
});

test('Responses writer emits lifecycle, sequence numbers and tool items', async () => {
  const { output } = await collect('responses', events);
  const names = frames(output).map(frame => frame.event);
  assert.equal(names[0], 'response.created');
  assert.ok(names.includes('response.output_item.added'));
  assert.ok(names.includes('response.output_text.delta'));
  assert.ok(names.includes('response.function_call_arguments.delta'));
  assert.equal(names.at(-1), 'response.completed');
  const sequences = frames(output).map(frame => JSON.parse(frame.data).sequence_number);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
});

test('Gemini writer emits data-only chunks without [DONE]', async () => {
  const { output } = await collect('gemini', events);
  const parsed = frames(output);
  assert.ok(parsed.length >= 3);
  assert.equal(parsed[0].event, 'message');
  assert.equal(parsed[0].data.startsWith('{'), true);
  const last = JSON.parse(parsed.at(-1).data);
  assert.equal(last.candidates[0].finishReason, 'STOP');
  assert.equal(last.usageMetadata.promptTokenCount, 3);
  assert.doesNotMatch(output, /\[DONE\]/);
});

test('Gemini writer supports the JSON array streaming alt', async () => {
  const { output } = await collect('gemini', events, { alt: 'json' });
  assert.match(output, /^\[/);
  assert.match(output, /\]$/);
  const array = JSON.parse(output);
  assert.ok(array.length >= 3);
  assert.equal(array.at(-1).candidates[0].finishReason, 'STOP');
});

test('Interactions writer emits the documented step event sequence', async () => {
  const { output, writer } = await collect('interactions', events);
  const names = frames(output).map(frame => frame.event);
  assert.equal(names[0], 'interaction.created');
  assert.equal(names[1], 'interaction.status_update');
  assert.ok(names.includes('step.start'));
  assert.ok(names.includes('step.delta'));
  assert.ok(names.includes('step.stop'));
  assert.equal(names.at(-2), 'interaction.completed');
  assert.equal(names.at(-1), 'done');
  const completed = frames(output).find(frame => frame.event === 'interaction.completed');
  assert.equal(JSON.parse(completed.data).interaction.status, 'requires_action');
  const steps = writer.getSteps();
  assert.equal(steps.some(step => step.type === 'thought'), true);
  assert.equal(steps.some(step => step.type === 'model_output'), true);
  assert.equal(steps.some(step => step.type === 'function_call'), true);
});

test('stream writers flush partial tool argument deltas', async () => {
  const deltas = [
    { delta: { blocks: [{ type: 'tool_call', id: 'c9', name: 'fn', argumentsText: '{"a":', streamDelta: true }] } },
    { delta: { blocks: [{ type: 'tool_call', index: 0, argumentsText: '1}', streamDelta: true }] } }
  ];
  const { output } = await collect('openai', deltas);
  const args = frames(output)
    .filter(frame => frame.data.startsWith('{'))
    .map(frame => JSON.parse(frame.data))
    .flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls || [])
    .filter(call => call.function?.arguments)
    .map(call => call.function.arguments)
    .join('');
  assert.equal(args, '{"a":1}');
});
