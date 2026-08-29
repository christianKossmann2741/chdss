import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePort, publicViewerUrl, redactToken } from '../src/config.js';

test('normalizePort accepts valid ports and rejects unsafe values', () => {
  assert.equal(normalizePort('41730'), 41730);
  assert.equal(normalizePort(undefined), 41730);
  assert.throws(() => normalizePort('0'), /port/i);
  assert.throws(() => normalizePort('65536'), /port/i);
  assert.throws(() => normalizePort('nope'), /port/i);
});

test('publicViewerUrl keeps pairing secret in URL fragment', () => {
  const url = publicViewerUrl('192.168.1.20', 41730, 'abc-123');
  assert.equal(url, 'http://192.168.1.20:41730/#abc-123');
  assert.equal(new URL(url).search, '');
});

test('redactToken never exposes the full pairing secret', () => {
  assert.equal(redactToken('0123456789abcdef'), '0123…cdef');
  assert.equal(redactToken('short'), '••••');
});
