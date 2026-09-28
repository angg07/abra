// fill('...') resolves {{...}} test values in saved tests: {{today+3}}, {{random}}, {{baseUrl}}, {{data.column}},
// {{SECRET_NAME}}. The full list is in app/vars-core.cjs. The app adds the calls when it saves a test.
import { test } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { makeResolver, secretsFromEnv, parseCsv } from '../../app/vars-core.cjs';

// variables of the environment chosen in the app (E2E_VARS); running from the CLI uses E2E_VARS or nothing
const vars: Record<string, string> = JSON.parse(process.env.E2E_VARS || '{}');
const runNow = new Date();
const perTest = new Map<string, { random: string }>(); // {{random}} stays the same within one test run

// Data set: tests/data/<test name>.csv; repeat i uses row i % rows (the app runs rows x times)
function dataRow(): Record<string, string> | null {
  const info = test.info();
  const name = basename(info.file).replace(/\.spec\.ts$/, '.csv');
  const file = join(process.env.E2E_DATA_DIR || join(dirname(info.file), 'data'), name);
  if (!existsSync(file)) return null;
  const rows = parseCsv(readFileSync(file, 'utf8'));
  if (!rows.length) return null;
  return rows[info.repeatEachIndex % rows.length]; // repeats cycle through the rows (rows x times)
}

export function fill(text: string): string {
  const info = test.info();
  const key = `${info.testId}#${info.repeatEachIndex}`;
  if (!perTest.has(key)) perTest.set(key, { random: String(Math.floor(100000 + Math.random() * 900000)) });
  return makeResolver({
    vars,
    secrets: secretsFromEnv(),
    envName: process.env.E2E_ENV, // NAME_<ENV> secrets win in that environment
    row: /\{\{\s*data\./.test(text) ? dataRow() : null,
    now: runNow,
    random: perTest.get(key)!.random,
  }).fill(text);
}
