import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guideCollector, replayStep, aiStep, secretMasker } from '../guide.mjs';

test('box frames pair with click steps in order, whichever arrives first', () => {
  const c = guideCollector(() => 'plain');
  c.highlight('BOX1', { name: 'Login', kind: 'button' }); // replay: box before its step event
  c.add({ mode: 'before', what: 'Click the element', verb: 'Click', generic: true, wantsBox: true });
  c.add({ mode: 'before', what: 'Check that “Products” is visible' }); // not a click: own frame
  c.add({ mode: 'before', what: 'Click the element', verb: 'Click', generic: true, wantsBox: true });
  c.highlight('BOX2', { name: '', kind: 'icon' }); // AI: box after its step
  assert.deepEqual(c.finish().map(s => [s.what, s.frame]), [
    ['Click the “Login” button', 'BOX1'],
    ['Check that “Products” is visible', 'plain'],
    ['Click the highlighted icon', 'BOX2'],
  ]);
});

test('"after" steps take the frame from when the next step starts', () => {
  let frame = 'empty form';
  const c = guideCollector(() => frame);
  c.add({ mode: 'after', what: 'Fill in the form' });
  frame = 'filled form';
  c.add({ mode: 'before', what: 'Click Save' });
  assert.equal(c.finish()[0].frame, 'filled form');
});

test('headings: a single test title is dropped, empty sections too', () => {
  const c = guideCollector(() => 'f');
  c.add({ section: 'the test', level: 1 });
  c.add({ section: 'login', level: 2 });
  c.add({ mode: 'before', what: 'Click' });
  c.add({ section: 'empty', level: 2 });
  assert.deepEqual(c.finish().map(s => s.section ?? s.what), ['login', 'Click']);
});

test('replay steps read the locator from the test source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guide-'));
  const file = join(dir, 'x.spec.ts');
  writeFileSync(file, [
    "await page.getByRole('button', { name: 'Checkout' }).click();",
    "await page.getByPlaceholder('First Name').fill('Budi');",
    "await page.locator('[data-test=\"cart\"]').click();",
  ].join('\n'));
  const mask = t => t;
  assert.equal(replayStep({ title: 'Click', category: 'pw:api', file, line: 1 }, mask).what, 'Click the “Checkout” button');
  assert.deepEqual(replayStep({ title: 'Fill "Budi"', category: 'pw:api', file, line: 2 }, mask), { mode: 'after', what: 'Fill in the “First Name” field', detail: 'Budi' });
  assert.equal(replayStep({ title: 'Click', category: 'pw:api', file, line: 3 }, mask).generic, true);
  rmSync(dir, { recursive: true });
});

test('AI clicks without an element name are marked for naming from the box', () => {
  assert.equal(aiStep({ name: 'browser_click', input: { target: 'e77' } }).generic, true);
  assert.equal(aiStep({ name: 'browser_click', input: { element: 'Login button' } }).generic, false);
  assert.equal(aiStep({ name: 'browser_snapshot', input: {} }), null); // not a user action
});

test("secret masking covers only the run's own project's secrets", () => {
  const env = { SECRET_SHOP_PW: 'shop_secret', SECRET_APP_PASS: 'password', SECRET_SHORT: 'ab', DBPASS_X: 'secret' };
  const mask = secretMasker(['SHOP_PW', 'SHORT'], env);
  assert.equal(mask('typed shop_secret'), 'typed {{SHOP_PW}}');
  // another project's secret, or a database password, that is also a word on the page stays as it is:
  // masking it would reveal that some secret equals that word
  assert.equal(mask('the password field, a secret menu, ab'), 'the password field, a secret menu, ab');
});

test('regex names in locators read as plain text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guide-'));
  const file = join(dir, 'x.spec.ts');
  writeFileSync(file, [
    "await page.getByRole('link', { name: /^List Claim/ }).click();",
    "await page.getByRole('button', { name: /Jane Doe .*Employee/ }).click();",
    "await page.getByRole('link', { name: 'Claim', exact: true }).click();",
  ].join('\n'));
  const what = line => replayStep({ title: 'Click', category: 'pw:api', file, line }, t => t).what;
  assert.equal(what(1), 'Click the “List Claim” link');
  assert.equal(what(2), 'Click the “Jane Doe … Employee” button');
  assert.equal(what(3), 'Click the “Claim” link');
  rmSync(dir, { recursive: true });
});
