// Test values written as {{...}} in instructions and tests. Shared by the MCP proxy (AI runs), the server,
// and saved tests (via tests/support/vars.ts). CommonJS so both ESM and Playwright's TS loader can use it.
//
//   {{today}} {{today+3}} {{today-7}}   local date, YYYY-MM-DD
//   {{now}}                             local date and time, YYYY-MM-DD HH:mm
//   {{...|DD/MM/YYYY}}                  any date value with a format (YYYY MM DD HH mm)
//   {{random}}                          6 digits, the same everywhere within one run
//   {{runId}}                           YYYYMMDDHHmmss of the run, the same everywhere within one run
//   {{data.column}}                     a column of the current data-set row
//   {{baseUrl}}, {{anyName}}            variables of the chosen environment
//   {{SECRET_NAME}}                     secrets (uppercase names), from SECRET_* in .env; in environment "e2e"
//                                       a secret NAME_E2E, if set, is used instead of NAME

const pad = n => String(n).padStart(2, '0');
function format(d, fmt) {
  return fmt.replace(/YYYY|MM|DD|HH|mm/g, t => ({ YYYY: d.getFullYear(), MM: pad(d.getMonth() + 1), DD: pad(d.getDate()), HH: pad(d.getHours()), mm: pad(d.getMinutes()) }[t]));
}

// secret for an environment: NAME_<ENV> (env name in capitals) wins over NAME
const envSuffix = envName => String(envName ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
const pickSecret = (secrets, name, envName) => (envName && secrets[`${name}_${envSuffix(envName)}`] !== undefined ? secrets[`${name}_${envSuffix(envName)}`] : secrets[name]);

function makeResolver({ vars = {}, secrets = {}, row = null, now = new Date(), runId, random, envName } = {}) {
  const stamp = runId ?? format(now, 'YYYYMMDDHHmm') + pad(now.getSeconds());
  const rnd = random ?? String(Math.floor(100000 + Math.random() * 900000));
  function value(expr) {
    const [name, fmt] = expr.split('|').map(s => s.trim());
    const day = name.match(/^today\s*([+-]\s*\d+)?$/);
    if (day) {
      const d = new Date(now); d.setDate(d.getDate() + Number((day[1] ?? '0').replace(/\s/g, '')));
      return format(d, fmt || 'YYYY-MM-DD');
    }
    if (name === 'now') return format(now, fmt || 'YYYY-MM-DD HH:mm');
    if (name === 'random') return rnd;
    if (name === 'runId') return stamp;
    const col = name.match(/^data\.(.+)$/);
    if (col) {
      if (!row) throw new Error(`{{${name}}} needs a data set: add one to this test (Saved tests > Edit)`);
      if (!(col[1] in row)) throw new Error(`The data set has no column "${col[1]}"`);
      return row[col[1]];
    }
    if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
      const value = pickSecret(secrets, name, envName);
      if (value === undefined) throw new Error(`Unknown secret {{${name}}}: add it in Settings > Secrets`);
      return value;
    }
    if (vars[name] === undefined) throw new Error(`Unknown value {{${name}}}: define it in the environment (Settings > Environments)`);
    return String(vars[name]);
  }
  const fill = text => String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, expr) => value(expr));
  // for tool arguments: fill every string inside objects/arrays
  const fillDeep = v => typeof v === 'string' ? fill(v)
    : Array.isArray(v) ? v.map(fillDeep)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x)]))
    : v;
  return { fill, fillDeep };
}

const secretsFromEnv = (env = process.env) =>
  Object.fromEntries(Object.entries(env).filter(([k, v]) => k.startsWith('SECRET_') && v).map(([k, v]) => [k.slice(7), v]));

// Minimal CSV: header row, comma-separated, "quoted, values" and "" escapes
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text).replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.some(x => x.trim()));
  if (!head) return [];
  const cols = head.map(h => h.trim());
  return body.map(r => Object.fromEntries(cols.map((c, i) => [c, (r[i] ?? '').trim()])));
}

module.exports = { makeResolver, secretsFromEnv, parseCsv, format, pickSecret };
