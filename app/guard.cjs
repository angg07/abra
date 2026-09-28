// Production guard. Every web address in an environment marked "production" (Settings > Environments) is
// blocked in every browser the app starts: the AI's, the replay runner's, and `npx playwright test`. Chromium is
// told these host names do not exist (--host-resolver-rules), so no request, not even the first, reaches them.
// Exact host names only: staging.example.com stays allowed when example.com is production.
// ponytail: host names, not IP addresses (resolver rules only map names); Node-side requests from test code
// (the `request` fixture) are not covered: non-developer users do not write test code.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const settingsFile = join(__dirname, 'settings.json');
const hostOf = u => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };

const productionHosts = (environments = []) => [...new Set(environments.filter(e => e.production)
  .flatMap(e => Object.values(e.vars ?? {}).map(hostOf).filter(Boolean)))];

const productionHostsFromSettings = () => {
  try { return productionHosts(JSON.parse(readFileSync(settingsFile, 'utf8')).environments); } catch { return []; }
};

const isProduction = (url, hosts) => hosts.includes(hostOf(url));

// Chromium flag; ~NOTFOUND answers "no such host" for that exact name
const blockArgs = hosts => (hosts.length ? [`--host-resolver-rules=${hosts.map(h => `MAP ${h} ~NOTFOUND`).join(', ')}`] : []);

module.exports = { hostOf, productionHosts, productionHostsFromSettings, isProduction, blockArgs };
