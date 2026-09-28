import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciWorkflow } from '../ci.mjs';

test('workflow maps each secret and reads environment values from E2E_VARS', () => {
  const y = ciWorkflow({ secrets: ['APP_PASS', 'ADMIN_PASS'] });
  assert.match(y, /SECRET_APP_PASS: \$\{\{ secrets\.APP_PASS \}\}/);
  assert.match(y, /SECRET_ADMIN_PASS: \$\{\{ secrets\.ADMIN_PASS \}\}/);
  assert.match(y, /E2E_VARS: \$\{\{ vars\.E2E_VARS \}\}/);
  assert.match(y, /npm run test:app/);
  assert.doesNotMatch(y, /\n\t/); // YAML: spaces only
});
