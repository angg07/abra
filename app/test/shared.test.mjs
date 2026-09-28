import { test } from 'node:test';
import assert from 'node:assert/strict';
import { md, esc, splitAnswer, lineDiff, issueLabel, flakyOf, expectedVerdict } from '../shared.mjs';

test('markdown from the AI is escaped (no HTML injection into the app)', () => {
  const html = md('**bold** `code` <img src=x onerror=alert(1)>\n- item');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.equal(esc('"<&>'), '&quot;&lt;&amp;&gt;');
});

test('AI answer splits into evidence and script', () => {
  const { evidence, script } = splitAnswer('RESULT: SUCCESS\n\nLogged in.\n\n```ts\ntest(1)\n```');
  assert.equal(evidence, 'Logged in.');
  assert.equal(script, 'test(1)\n');
});

test('diff: removed lines before added, counts right', () => {
  const d = lineDiff('a\nold\nc', 'a\nnew\nc');
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.ok(d.html.indexOf('- old') < d.html.indexOf('+ new'));
});

test('issue labels', () => {
  assert.equal(issueLabel({ kind: 'http', status: 500 }), 'HTTP 500');
  assert.equal(issueLabel({ kind: 'exception' }), 'JavaScript error');
});

test('flaky: same test and row both passing and failing across repeats', () => {
  const t = (title, status, row) => ({ file: 'a.spec.ts', title, status, row });
  assert.deepEqual(flakyOf([t('x', 'passed'), t('x', 'failed'), t('x', 'passed'), t('y', 'failed'), t('y', 'failed'), t('z', 'passed', 1), t('z', 'failed', 2)]),
    [{ file: 'a.spec.ts', title: 'x', row: undefined, passed: 2, total: 3 }]); // y always fails, z differs by row: not flaky
});

test('expected-result verdict from the AI answer', () => {
  assert.equal(expectedVerdict('RESULT: SUCCESS\nEXPECTED: MET\nSaw it.'), true);
  assert.equal(expectedVerdict('RESULT: FAILED\n**EXPECTED: NOT MET**'), false);
  assert.equal(expectedVerdict('RESULT: SUCCESS'), null);
  assert.equal(splitAnswer('RESULT: SUCCESS\nEXPECTED: MET\nThe message appeared.').evidence, 'The message appeared.');
  assert.equal(splitAnswer('RESULT: FAILED\nEXPECTED: NOT MET. It never appeared.').evidence, 'It never appeared.');
});

test('findings are split: app errors, third-party, accessibility', async () => {
  const { isAppError, isThirdParty, isA11y } = await import('../shared.mjs');
  const list = [{ kind: 'http', thirdParty: false }, { kind: 'http', thirdParty: true }, { kind: 'a11y', thirdParty: false }];
  assert.deepEqual(list.map(i => [isAppError(i), isThirdParty(i), isA11y(i)]), [[true, false, false], [false, true, false], [false, false, true]]);
});
