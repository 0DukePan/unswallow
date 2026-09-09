import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAndRescue, validateEnvelope, type RawProviderResponse } from '../dist/src/index';

const tools = [{
  type: 'function',
  function: {
    name: 'get_weather',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' }, units: { enum: ['c', 'f'] } },
      required: ['city'],
      additionalProperties: false,
    },
  },
}];

function response(arguments_: Record<string, unknown>): RawProviderResponse {
  return {
    choices: [{
      message: {
        role: 'assistant', content: '', tool_calls: [],
        reasoning: `<thinking><tool_call>${JSON.stringify({ name: 'get_weather', arguments: arguments_ })}</tool_call></thinking>`,
      },
    }],
  };
}

test('validateEnvelope reports a known name and valid arguments', () => {
  assert.deepEqual(validateEnvelope({ name: 'get_weather', arguments: { city: 'Tokyo' } }, tools), {
    structurallyValid: true, nameKnown: 'yes', schemaValid: 'yes', errors: [],
  });
});

test('validateEnvelope safely rejects malformed schemas as unknown', () => {
  const result = validateEnvelope(
    { name: 'get_weather', arguments: { city: 'Tokyo' } },
    [{ function: { name: 'get_weather', parameters: { type: 'object', properties: [] as unknown as Record<string, unknown> } } }]
  );
  assert.equal(result.structurallyValid, true);
  assert.equal(result.schemaValid, 'unknown');
  assert.match(result.errors[0], /non-object properties/);
});

test('validateEnvelope treats malformed parameters and required schemas as unknown', () => {
  const envelope = { name: 'get_weather', arguments: { city: 'Tokyo' } };
  const malformedParameters = validateEnvelope(envelope, [{ function: { name: 'get_weather', parameters: [] as unknown as Record<string, unknown> } }]);
  const malformedRequired = validateEnvelope(envelope, [{ function: { name: 'get_weather', parameters: { type: 'object', required: 'city' as unknown as string[] } } }]);
  assert.equal(malformedParameters.schemaValid, 'unknown');
  assert.match(malformedParameters.errors[0], /parameters schema/);
  assert.equal(malformedRequired.schemaValid, 'unknown');
  assert.match(malformedRequired.errors[0], /non-array required/);
});

test('validation fuzz: malformed schema variants never throw or claim validity', () => {
  let state = 0xdecafbad;
  const next = () => (state = Math.imul(state ^ (state >>> 15), 1 | state) + 0x6d2b79f5 | 0) >>> 0;
  const malformed: unknown[] = [null, [], 'object', 1, true, { properties: [] }, { required: 'city' }, { properties: { city: [] } }];
  for (let i = 0; i < 400; i++) {
    const parameters = malformed[next() % malformed.length];
    const run = () => validateEnvelope(
      { name: 'get_weather', arguments: { city: i % 2 === 0 ? 'Tokyo' : i, nested: { i } } },
      [{ function: { name: 'get_weather', parameters: parameters as Record<string, unknown> } }]
    );
    assert.doesNotThrow(run);
    const result = run();
    if (parameters === null || !parameters || typeof parameters !== 'object' || Array.isArray(parameters) || (parameters as { properties?: unknown }).properties instanceof Array || typeof (parameters as { required?: unknown }).required === 'string') {
      assert.notEqual(result.schemaValid, 'yes');
    }
  }
});

test('strictSchema blocks an entire parallel recovery when one call is invalid', () => {
  const parallel: RawProviderResponse = {
    choices: [{ message: { role: 'assistant', content: '', tool_calls: [], reasoning: '<thinking><tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call><tool_call>{"name":"get_weather","arguments":{"city":3}}</tool_call></thinking>' } }],
  };
  const result = checkAndRescue(parallel, { toolSchemas: tools, strictSchema: true });
  assert.equal(result.detected, true);
  assert.equal(result.toolCalls!.length, 2);
  assert.equal(result.recovered, false);
});

test('invalid tool name and arguments receive multiplicative confidence penalties', () => {
  const result = checkAndRescue(response({ city: 42, extra: true }), {
    engineHint: 'vllm', engineVersion: '0.19.0',
    toolSchemas: [{ function: { name: 'other', parameters: { type: 'object' } } }],
  });
  assert.equal(result.validation!.nameKnown, 'no');
  assert.equal(result.confidence, 0.48);
  assert.equal(result.recovered, true);
});

test('strictSchema blocks recovery for invalid arguments while retaining detection', () => {
  const result = checkAndRescue(response({ units: 'kelvin' }), { toolSchemas: tools, strictSchema: true });
  assert.equal(result.detected, true);
  assert.equal(result.validation!.schemaValid, 'no');
  assert.equal(result.recovered, false);
  assert.equal(result.recoveredResponse, null);
});

test('minConfidence blocks otherwise structurally valid recovery', () => {
  const result = checkAndRescue(response({ city: 'Tokyo' }), { minConfidence: 0.6 });
  assert.equal(result.validation!.structurallyValid, true);
  assert.equal(result.recovered, false);
});
