import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHistory, stripReasoningTags } from '../dist/src/index';

test('stripReasoningTags removes complete think blocks', () => {
  const text =
    '< thinking>\nI should get the weather for Tokyo.\n< response>\nThe weather in Tokyo is 24C.';
  assert.equal(stripReasoningTags(text), 'The weather in Tokyo is 24C.');
});

test('stripReasoningTags removes XML thinking blocks', () => {
  const text = '<thinking>\nplanning\n</thinking>\nFinal answer here.';
  assert.equal(stripReasoningTags(text), 'Final answer here.');
});

test('stripReasoningTags keeps leak-region text but drops the tag', () => {
  const text = 'Here is the summary. <mm:think>I should verify the weather data first';
  assert.equal(stripReasoningTags(text), 'Here is the summary. I should verify the weather data first');
});

test('stripReasoningTags strips DeepSeek-style tool_call opener fragments', () => {
  const text = 'planning was done.\n工具调用tool_call分隔符\nThen the answer.';
  assert.equal(stripReasoningTags(text), 'planning was done.\nThen the answer.');
});

test('stripReasoningTags leaves plain assistant text untouched', () => {
  const text = 'The user asked about the weather and I answered directly.';
  assert.equal(stripReasoningTags(text), text);
});

test('stripReasoningTags does not eat user text containing the word think', () => {
  const text = 'I think this is a great question.';
  assert.equal(stripReasoningTags(text), 'I think this is a great question.');
});

test('sanitizeHistory strips reasoning fields and leaked tags, does not mutate input', () => {
  const history = [
    { role: 'user', content: 'What is the weather?' },
    {
      role: 'assistant',
      content: '< thinking>\nI need a tool.\n< response>\nLet me call the tool.',
      reasoning: '< thinking>\nI need a tool.\n< response>\n',
      reasoning_content: '< thinking>\nI need a tool.\n< response>\n',
    },
    { role: 'tool', content: '24C' },
  ];
  const frozen = JSON.stringify(history);
  const clean = sanitizeHistory(history);
  assert.equal(JSON.stringify(history), frozen);
  assert.equal(clean.length, 3);
  assert.equal(clean[0].content, 'What is the weather?');
  assert.equal(clean[1].content, 'Let me call the tool.');
  assert.equal('reasoning' in clean[1], false);
  assert.equal('reasoning_content' in clean[1], false);
  assert.equal(clean[2].content, '24C');
});

test('sanitizeHistory can keep reasoning fields via options', () => {
  const history = [
    { role: 'assistant', content: 'answer', thinking: '< thinking>\nplan\n< response>\n' },
  ];
  const clean = sanitizeHistory(history, { stripReasoningFields: false });
  assert.equal(clean[0].thinking, '< thinking>\nplan\n< response>\n');
});

test('sanitizeHistory can skip tag stripping via options', () => {
  const history = [
    { role: 'assistant', content: '< thinking>\nplan\n< response>\nanswer' },
  ];
  const clean = sanitizeHistory(history, { stripReasoningTags: false });
  assert.equal(clean[0].content, '< thinking>\nplan\n< response>\nanswer');
});

test('sanitizeHistory with both options disabled is a plain copy', () => {
  const history = [
    { role: 'assistant', content: 'x', thinking: 'y' },
  ];
  const clean = sanitizeHistory(history, { stripReasoningFields: false, stripReasoningTags: false });
  assert.deepEqual(clean, history);
});