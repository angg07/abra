import { test } from 'node:test';
import assert from 'node:assert/strict';
import guard from '../guard.cjs';

const envs = [
  { name: 'e2e', vars: { appUrl: 'http://myapp.e2e.localhost' } },
  { name: 'production', production: true, vars: { appUrl: 'https://Example.com/', adminUrl: 'https://admin.example.com:8443', note: 'not a url' } },
];

test('production hosts come only from environments marked production', () => {
  assert.deepEqual(guard.productionHosts(envs), ['example.com', 'admin.example.com']);
});

test('exact host names are blocked, on any port or path; subdomains are not', () => {
  const hosts = guard.productionHosts(envs);
  assert.equal(guard.isProduction('https://example.com/claims', hosts), true);
  assert.equal(guard.isProduction('http://EXAMPLE.com:8080', hosts), true);
  assert.equal(guard.isProduction('https://staging.example.com', hosts), false);
  assert.equal(guard.isProduction('http://myapp.e2e.localhost', hosts), false);
  assert.equal(guard.isProduction('{{appUrl}}', hosts), false); // not resolved yet: the server resolves first
});

test('Chromium flag maps each host to "not found"', () => {
  assert.deepEqual(guard.blockArgs(['a.com', 'b.org']), ['--host-resolver-rules=MAP a.com ~NOTFOUND, MAP b.org ~NOTFOUND']);
  assert.deepEqual(guard.blockArgs([]), []);
});
