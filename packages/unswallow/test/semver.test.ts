import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesRange, parseVersion } from '../dist/src/semver';

test('parseVersion handles 0.19.0, short and prefixed forms', () => {
  assert.deepEqual(parseVersion('0.19.0'), [0, 19, 0]);
  assert.deepEqual(parseVersion('1.2'), [1, 2, 0]);
  assert.deepEqual(parseVersion('v3'), [3, 0, 0]);
  assert.equal(parseVersion('garbage'), null);
});

test('<= range', () => {
  assert.equal(matchesRange('0.19.0', '<=0.19.0'), true);
  assert.equal(matchesRange('0.18.9', '<=0.19.0'), true);
  assert.equal(matchesRange('0.20.0', '<=0.19.0'), false);
});

test('>= range', () => {
  assert.equal(matchesRange('0.24.0', '>=0.24.0'), true);
  assert.equal(matchesRange('0.26.0', '>=0.24.0'), true);
  assert.equal(matchesRange('0.23.9', '>=0.24.0'), false);
});

test('ANDed comparators', () => {
  assert.equal(matchesRange('0.23.4', '>=0.20.0 <0.24.0'), true);
  assert.equal(matchesRange('0.20.0', '>=0.20.0 <0.24.0'), true);
  assert.equal(matchesRange('0.19.9', '>=0.20.0 <0.24.0'), false);
  assert.equal(matchesRange('0.24.0', '>=0.20.0 <0.24.0'), false);
});

test('wildcard and OR ranges', () => {
  assert.equal(matchesRange('0.24.0', '*'), true);
  assert.equal(matchesRange('0.24.0', '<0.20.0 || >=0.24.0'), true);
  assert.equal(matchesRange('0.22.0', '<0.20.0 || >=0.24.0'), false);
});

test('exact equality', () => {
  assert.equal(matchesRange('0.19.0', '0.19.0'), true);
  assert.equal(matchesRange('0.19.1', '0.19.0'), false);
});

test('invalid inputs never match', () => {
  assert.equal(matchesRange('not-a-version', '*'), false);
  assert.equal(matchesRange('0.19.0', 'not-a-range'), false);
  assert.equal(matchesRange('', '*'), false);
});

test('build-tag versions (llama.cpp style) match wildcard ranges', () => {
  assert.equal(matchesRange('b8461', '*'), true);
  assert.equal(matchesRange('b8461', '>=10000.0.0'), false);
});
