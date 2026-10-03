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

test('the test is found after other code blocks (a mermaid diagram first)', () => {
  const answer = 'RESULT: SUCCESS\n\n```mermaid\nstateDiagram-v2\n  A --> B\n```\n\n### Playwright test\n\n```ts\nimport { test } from \'@playwright/test\';\ntest(1)\n```\n\n```json\n{"a":1}\n```';
  const { evidence, script } = splitAnswer(answer);
  assert.equal(script, 'import { test } from \'@playwright/test\';\ntest(1)\n');
  assert.equal(evidence, '### Playwright test');
});

test('no test in the answer: no script', () => {
  assert.equal(splitAnswer('RESULT: FAILED\n\n```mermaid\nA --> B\n```\n\nBlocked.').script, null);
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

test('the code a browser action ran is read from a Playwright MCP result', async () => {
  const { ranCode } = await import('../shared.mjs');
  const result = "### Ran Playwright code\n```js\nawait page.getByRole('button', { name: 'Save' }).click();\n```\n### Page\n- Page URL: http://myapp.test/";
  assert.equal(ranCode(result), "await page.getByRole('button', { name: 'Save' }).click();");
  assert.equal(ranCode('### Snapshot\n- button "Save"'), null);
});

test('without a test in the answer, one is built from the code the browser ran', async () => {
  const { scriptFromCode, splitAnswer } = await import('../shared.mjs');
  const s = scriptFromCode("Polis 'Marine' Hull", ["await page.goto('http://myapp.test/');", "await page.getByLabel('Name').fill('Budi');\nawait page.keyboard.press('Enter');"]);
  assert.equal(s, `import { test, expect } from '@playwright/test';

test('Polis \\'Marine\\' Hull', async ({ page }) => {
  await page.goto('http://myapp.test/');
  await page.getByLabel('Name').fill('Budi');
  await page.keyboard.press('Enter');
});
`);
  assert.equal(splitAnswer('RESULT: SUCCESS\n\n```ts\n' + s + '```').script, s); // the same shape as one the AI writes
});

test('an upload step in the browser code becomes a file chooser block the test can run', async () => {
  const { scriptFromCode } = await import('../shared.mjs');
  const s = scriptFromCode('Upload', ["await page.locator('#f').click();", 'await fileChooser.setFiles(["{{file.a.xlsx}}"])', "await page.getByRole('button', { name: 'Save' }).click();"]);
  assert.equal(s, `import { test, expect } from '@playwright/test';

test('Upload', async ({ page }) => {
  {
    const fileChooser = page.waitForEvent('filechooser');
    await page.locator('#f').click();
    await (await fileChooser).setFiles(["{{file.a.xlsx}}"]);
  }
  await page.getByRole('button', { name: 'Save' }).click();
});
`);
});
