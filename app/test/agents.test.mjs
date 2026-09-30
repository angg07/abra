import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolArgs, usableCodebase, codebaseNote } from '../agents.mjs';

const flag = (args, name) => args[args.indexOf(name) + 1];

test('without a codebase the AI has the browser only', () => {
  const args = toolArgs([]);
  assert.equal(flag(args, '--tools'), '');
  assert.equal(flag(args, '--allowedTools'), 'mcp__playwright');
  assert.ok(!args.includes('--add-dir'));
});

test('with codebase folders (frontend + backend): read-only tools on each, secret files denied', () => {
  const args = toolArgs(['/src/shop-fe', '/src/shop-api']);
  assert.equal(flag(args, '--tools'), 'Read,Grep,Glob');
  assert.deepEqual(args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : [])), ['/src/shop-fe', '/src/shop-api']);
  assert.doesNotMatch(args.join(' '), /Edit|Write|Bash/);
  const denied = flag(args, '--disallowedTools');
  for (const g of ['**/.env*', '**/*.pem', '**/*.key']) assert.ok(denied.includes(`Read(${g})`), g);
});

test('a missing folder is not used; the note says pass/fail comes from the screen', () => {
  assert.equal(usableCodebase('/no/such/folder'), false);
  assert.equal(usableCodebase(''), false);
  assert.equal(usableCodebase(import.meta.dirname), true);
  assert.match(codebaseNote(['/src/shop-fe', '/src/shop-api']), /\/src\/shop-fe, \/src\/shop-api.*only from what the browser shows/s);
});
