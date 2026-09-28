import { test } from 'node:test';
import assert from 'node:assert/strict';
import core from '../vars-core.cjs';
const { makeResolver, parseCsv } = core;

const now = new Date(2026, 8, 26, 14, 5); // 26 Sep 2026 14:05 local
const r = makeResolver({ vars: { baseUrl: 'http://myapp.test' }, secrets: { PW: 's3cret' }, row: { amount: '500000' }, now, random: '123456' });

test('dates, formats and built-ins', () => {
  assert.equal(r.fill('{{today}}'), '2026-09-26');
  assert.equal(r.fill('{{today+7}}'), '2026-10-03'); // crosses a month
  assert.equal(r.fill('{{ today - 30 }}'), '2026-08-27');
  assert.equal(r.fill('{{today+3|DD/MM/YYYY}}'), '29/09/2026');
  assert.equal(r.fill('{{now}}'), '2026-09-26 14:05');
  assert.equal(r.fill('Claim {{random}}-{{random}}'), 'Claim 123456-123456'); // same value within a run
});

test('environment values, data rows and secrets', () => {
  assert.equal(r.fill('{{baseUrl}}/claims'), 'http://myapp.test/claims');
  assert.equal(r.fill('{{data.amount}}'), '500000');
  assert.equal(r.fill('{{PW}}'), 's3cret');
  assert.deepEqual(r.fillDeep({ a: ['{{today}}', 1], b: { c: '{{PW}}' } }), { a: ['2026-09-26', 1], b: { c: 's3cret' } });
});

test('unknown values fail loudly instead of typing the placeholder', () => {
  assert.throws(() => r.fill('{{typo}}'), /Unknown value \{\{typo\}\}/);
  assert.throws(() => r.fill('{{MISSING}}'), /Unknown secret/);
  assert.throws(() => r.fill('{{data.nope}}'), /no column "nope"/);
  assert.throws(() => makeResolver().fill('{{data.x}}'), /needs a data set/);
});

test('CSV: quotes, escaped quotes, blank lines, CRLF', () => {
  assert.deepEqual(parseCsv('name,amount\r\n"Budi, S",500000\n\nAni,"1""2"\n'), [
    { name: 'Budi, S', amount: '500000' },
    { name: 'Ani', amount: '1"2' },
  ]);
  assert.deepEqual(parseCsv(''), []);
});

test('a secret NAME_<ENV> wins in that environment only', () => {
  const secrets = { APP_DB: 'live', APP_DB_E2E: 'test-copy' };
  assert.equal(makeResolver({ secrets, envName: 'e2e' }).fill('{{APP_DB}}'), 'test-copy');
  assert.equal(makeResolver({ secrets, envName: 'local' }).fill('{{APP_DB}}'), 'live');
  assert.equal(makeResolver({ secrets }).fill('{{APP_DB}}'), 'live');
  assert.equal(core.pickSecret({ A_STAGING_EU: 'x', A: 'y' }, 'A', 'staging-eu'), 'x'); // env names become NAME_STAGING_EU
});
