// The MCP proxy records the code each browser action ran, so a test can be built when the AI writes none.
// Real proxy + Playwright MCP + headless Chromium: a few seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('the proxy appends the code of every browser action to CODE_LOG', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'abr-proxy-'));
  const log = join(tmp, 'ran-code.jsonl');
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ['mcp-proxy.mjs', '--headless', '--isolated', '--browser', 'chromium', '--output-dir', join(tmp, 'mcp')],
    cwd: join(import.meta.dirname, '..'), env: { ...process.env, CODE_LOG: log }, stderr: 'ignore',
  }));
  try {
    await client.callTool({ name: 'browser_navigate', arguments: { url: 'data:text/html,<h1>Hi</h1>' } });
    await client.callTool({ name: 'browser_snapshot', arguments: {} }); // reads the page: no code
    const code = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.deepEqual(code, ["await page.goto('data:text/html,<h1>Hi</h1>');"]);
  } finally {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('an AI uploads a run file with {{file.X}}; it reads and records {{file.X}}, never the path', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'abr-proxy-'));
  const out = join(tmp, 'mcp'), files = join(out, 'files'), log = join(tmp, 'ran-code.jsonl');
  mkdirSync(files, { recursive: true });
  writeFileSync(join(files, 'template-klaim.xlsx'), 'x');
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ['mcp-proxy.mjs', '--headless', '--isolated', '--browser', 'chromium', '--output-dir', out],
    cwd: join(import.meta.dirname, '..'), stderr: 'ignore',
    env: { ...process.env, CODE_LOG: log, RUN_VARS: JSON.stringify({ files: { 'template-klaim.xlsx': join(files, 'template-klaim.xlsx') } }) },
  }));
  const text = r => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  try {
    await client.callTool({ name: 'browser_navigate', arguments: { url: 'data:text/html,<input type=file id=f onchange="document.title=this.files[0].name">' } });
    await client.callTool({ name: 'browser_click', arguments: { element: 'file input', target: '#f' } });
    const up = text(await client.callTool({ name: 'browser_file_upload', arguments: { paths: ['{{file.template-klaim.xlsx}}'] } }));
    assert.match(up, /Page Title: template-klaim\.xlsx/); // the real file reached the page
    assert.doesNotMatch(up, new RegExp(files.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); // the AI never sees the file's path (the snapshot link still shows the output folder)
    const code = readFileSync(log, 'utf8');
    assert.match(code, /fileChooser\.setFiles\(\[\\"\{\{file\.template-klaim\.xlsx\}\}\\"\]\)/);
    assert.doesNotMatch(code, new RegExp(files.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
