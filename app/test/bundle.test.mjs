import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packProject, unpackBundle, missingVars } from '../bundle.mjs';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
function sampleDir() {
  const dir = mkdtempSync(join(tmpdir(), 'abr-bundle-'));
  writeFileSync(join(dir, 'project.json'), '{"name":"Shop"}');
  writeFileSync(join(dir, 'login.spec.ts'), "await page.goto('{{shopUrl}}/login');\nfill('{{today}} {{data.user}} {{APP_PASS}} {{now|DD/MM/YYYY}} {{runId}} {{today+3|DD/MM}} {{file.Template-Klaim.xlsx}}');");
  mkdirSync(join(dir, 'data')); writeFileSync(join(dir, 'data', 'login.csv'), 'user\nann\n');
  mkdirSync(join(dir, 'workflows')); writeFileSync(join(dir, 'workflows', 'buy.json'), '{"name":"Buy","blocks":[{"prompt":"{{params.x}} {{blocks.a.b}} {{item.name}} {{baseUrl}}"}]}');
  mkdirSync(join(dir, 'login.spec.ts-snapshots')); writeFileSync(join(dir, 'login.spec.ts-snapshots', 'home.png'), png);
  mkdirSync(join(dir, 'files', 'login'), { recursive: true }); writeFileSync(join(dir, 'files', 'login', 'Template-Klaim.xlsx'), png);
  return dir;
}
const good = () => packProject(sampleDir(), { id: 'shop', name: 'Shop' }, ['APP_PASS']);

test('pack → unpack gives back the same bytes, text and PNG', () => {
  const b = good();
  assert.equal(b.format, 'ai-browser-runner-project'); assert.equal(b.version, 1);
  assert.deepEqual(b.secrets, ['APP_PASS']);
  assert.equal(b.files['project.json'], undefined);
  const out = unpackBundle(JSON.parse(JSON.stringify(b)));
  const byPath = Object.fromEntries(out.files.map(f => [f.path, f.data]));
  assert.deepEqual(Object.keys(byPath).sort(), ['data/login.csv', 'files/login/Template-Klaim.xlsx', 'login.spec.ts', 'login.spec.ts-snapshots/home.png', 'workflows/buy.json']);
  assert.deepEqual(byPath['login.spec.ts-snapshots/home.png'], png);
  assert.deepEqual(byPath['files/login/Template-Klaim.xlsx'], png);
  assert.equal(byPath['data/login.csv'].toString(), 'user\nann\n');
  assert.equal(out.project.id, 'shop');
});

const withFile = (path, entry) => { const b = good(); b.files[path] = entry; return b; };
const bad = [
  ['path with ..', withFile('../x.spec.ts', { text: '' }), /not allowed/],
  ['absolute path', withFile('/etc/x.spec.ts', { text: '' }), /not allowed/],
  ['windows drive', withFile('C:\\x.spec.ts', { text: '' }), /not allowed/],
  ['backslash', withFile('data\\x.csv', { text: '' }), /not allowed/],
  ['shell script', withFile('data/x.sh', { text: '' }), /not allowed/],
  ['test under data/', withFile('data/x.spec.ts', { text: '' }), /not allowed/],
  ['png as text', withFile('login.spec.ts-snapshots/a.png', { text: 'x' }), /base64/],
  ['both text and base64', withFile('a.spec.ts', { text: 'x', base64: 'eA==' }), /exactly one/],
  ['file outside a test folder', withFile('files/x.xlsx', { base64: '' }), /not allowed/],
  ['file as text', withFile('files/login/a.xlsx', { text: '' }), /must be stored as base64/],
  ['wrong format', { ...good(), format: 'zip' }, /not an ABRA project file/],
  ['wrong version', { ...good(), version: 2 }, /version 2/],
  ['bad project id', { ...good(), project: { id: '../x', name: 'X' } }, /project id/],
  ['not an object', 'hello', /not an ABRA project file/],
];
for (const [name, bundle, message] of bad)
  test(`rejects: ${name}`, () => assert.throws(() => unpackBundle(bundle), message));

test('missingVars: environment values that no environment has; built-ins and secrets are not reported', () => {
  const { files } = unpackBundle(good());
  assert.deepEqual(missingVars(files, [{ vars: { appUrl: 'x' } }]), ['baseUrl', 'shopUrl']);
  assert.deepEqual(missingVars(files, [{ vars: { shopUrl: 'x' } }, { vars: { baseUrl: 'y' } }]), []);
});

// review: reserved folder names must never become project ids (overwrite would wipe tests/support)
for (const id of ['support', 'data'])
  test(`rejects: reserved project id "${id}"`, () => assert.throws(() => unpackBundle({ ...good(), project: { id, name: 'X' } }), /reserved/));
// review: a non-string or empty name breaks the Projects page for every project
for (const [name, project] of [['name not a string', { id: 'shop', name: 42 }], ['empty name', { id: 'shop', name: ' ' }], ['url not http or {{', { id: 'shop', name: 'S', url: 'javascript:alert(1)' }]])
  test(`rejects: ${name}`, () => assert.throws(() => unpackBundle({ ...good(), project }), /name|URL/));

test('saved prompts and their files travel in the bundle', () => {
  const dir = sampleDir();
  mkdirSync(join(dir, 'prompts')); writeFileSync(join(dir, 'prompts', 'b1.json'), '{"task":"Create a policy","files":["Slip.pdf"]}');
  mkdirSync(join(dir, 'prompt-files', 'b1'), { recursive: true }); writeFileSync(join(dir, 'prompt-files', 'b1', 'Slip.pdf'), png);
  const { files } = unpackBundle(JSON.parse(JSON.stringify(packProject(dir, { id: 'shop', name: 'Shop' }, []))));
  const by = Object.fromEntries(files.map(f => [f.path, f.data]));
  assert.equal(by['prompts/b1.json'].toString(), '{"task":"Create a policy","files":["Slip.pdf"]}');
  assert.deepEqual(by['prompt-files/b1/Slip.pdf'], png);
});
