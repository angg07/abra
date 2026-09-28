// MCP proxy in front of Playwright MCP that keeps secrets away from the AI.
// The AI writes {{NAME}}; we substitute SECRET_NAME from .env (and other {{...}} test values) right before the browser tool runs,
// and mask the real values back to {{NAME}} in everything the AI reads. Works for any engine.
// Usage: started per AI run by the server (runs.mjs mcpServerFor): node mcp-proxy.mjs <@playwright/mcp args...>
import { join } from 'node:path';
import varsCore from './vars-core.cjs';
const { makeResolver } = varsCore;
import guard from './guard.cjs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

try { process.loadEnvFile(join(import.meta.dirname, '..', '.env')); } catch {}
const secrets = Object.entries(process.env)
  .filter(([k, v]) => k.startsWith('SECRET_') && v)
  .map(([k, v]) => [k.slice('SECRET_'.length), v]);
// {{...}} test values (dates, random, environment variables, secrets) are resolved right before a tool runs.
// The server starts one proxy per AI run and passes that run's environment values and allowed secret
// names in RUN_VARS. Only the run's project's secrets can be filled in, and only those are masked.
let runVars = {}, envName = '', allowed = [];
try { ({ vars: runVars = {}, env: envName = '', secrets: allowed = [] } = JSON.parse(process.env.RUN_VARS ?? '{}')); } catch {}
const byName = Object.fromEntries(secrets.filter(([n]) => allowed.includes(n)));
const { fillDeep } = makeResolver({ vars: runVars, secrets: byName, envName });
// ponytail: plain substring masking; values shorter than 4 chars are skipped to avoid masking random text
// only the secrets this run can type; masking others would hint that some secret equals a word on the page
const mask = text => Object.entries(byName).reduce((t, [n, v]) => v.length >= 4 ? t.split(v).join(`{{${n}}}`) : t, text);

const productionHosts = guard.productionHostsFromSettings(); // the browser cannot reach them anyway; this tells the AI why

const upstream = new Client({ name: 'secret-proxy', version: '1.0.0' });
const cli = join(import.meta.dirname, '..', 'node_modules', '@playwright', 'mcp', 'cli.js'); // not in the package's exports map
await upstream.connect(new StdioClientTransport({ command: process.execPath, args: [cli, ...process.argv.slice(2)], stderr: 'inherit' }));

const server = new Server({ name: 'playwright', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools());
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  let args;
  try { args = fillDeep(params.arguments ?? {}); }
  catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; } // tell the AI, don't crash
  if (params.name === 'browser_navigate' && guard.isProduction(args.url, productionHosts))
    return { content: [{ type: 'text', text: `Error: BLOCKED. ${guard.hostOf(args.url)} is a production address; this app never opens it. Do not look for another way in. Stop and answer RESULT: FAILED, saying the address is production.` }], isError: true };
  const out = await upstream.callTool({ name: params.name, arguments: args });
  return { ...out, content: (out.content ?? []).map(c => c.type === 'text' ? { ...c, text: mask(c.text) } : c) };
});
await server.connect(new StdioServerTransport());
