import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireLocalDatabase } from '../scripts/local-database';
test('Database tooling accepts loopback URLs only', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const url = `postgresql://postgres:postgres@${host}:5432/cocos`;
    assert.equal(requireLocalDatabase(url), url);
  }
  for (const url of [
    undefined,
    'postgresql://db.example.com/cocos',
    'postgresql://localhost/cocos?host=db.example.com',
    'postgresql://localhost/cocos?hostaddr=1.2.3.4',
    'https://localhost/cocos',
  ]) {
    assert.throws(() => requireLocalDatabase(url));
  }
});
