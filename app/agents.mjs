// Two engines, one contract: engine(opts, emit, signal) → { text, turns }
// emit('text', string) and emit('tool', { name, input }) stream progress to the UI.
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnOptions, shellArgs, stopChild } from './proc.mjs';
import { resolveConfigDir } from './claude-config.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const MAX_TURNS = 80;
const KEEP_FULL_RESULTS = 3; // older tool outputs (mostly page snapshots) get truncated to save tokens

// The project's source code (optional, Claude Code only): read-only, and files that usually hold secrets stay
// closed (the deny rules cover Grep and Glob too)
const CODE_TOOLS = 'Read,Grep,Glob';
const SECRET_FILES = ['**/.env*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_ed25519*', '**/.npmrc', '**/auth.json', '**/.git/**'];
export const codebaseNote = folders => `\n\nThe application's source code is in ${folders.join(', ')} (read-only: Read, Grep, Glob; separate folders are usually separate parts such as the frontend and the backend). Use it only when it helps the browser task: routes and page addresses, form fields and their validation rules, test ids for locators, or why something fails. Read as little as needed. Decide success or failure only from what the browser shows, never from what the code says should happen.`;
// the browser always; with codebase folders, reading them too (no Edit, Write or Bash)
export const toolArgs = folders => (folders?.length
  ? ['--tools', CODE_TOOLS, '--allowedTools', `mcp__playwright,${CODE_TOOLS}`, ...folders.flatMap(f => ['--add-dir', f]), '--disallowedTools', SECRET_FILES.map(g => `Read(${g})`).join(',')]
  : ['--tools', '', '--allowedTools', 'mcp__playwright']);
export const usableCodebase = folder => Boolean(folder) && existsSync(folder) && statSync(folder).isDirectory();

// Claude Code CLI: uses whatever auth the local `claude` has (subscription login or ANTHROPIC_API_KEY)
export function claudeCode({ provider, model, prompt, system, mcpConfigPath, cwd, codebase }, emit, signal) {
  return new Promise((resolve, reject) => {
    const wanted = [].concat(codebase ?? []).filter(Boolean); // older projects hold one path as a string
    const code = wanted.filter(usableCodebase);
    for (const f of wanted) if (!code.includes(f)) emit('log', `Codebase folder not found, run without it: ${f}`);
    // prompt on stdin and the system prompt in a file: on Windows `claude` only starts through cmd.exe, which
    // would mangle free text passed as arguments (quotes, &, |, %VAR%)
    const systemFile = join(dirname(mcpConfigPath), 'system.txt'); // in the run's folder, removed with it
    writeFileSync(systemFile, code.length ? system + codebaseNote(code) : system);
    const claude = spawn('claude', shellArgs([
      '-p',
      '--append-system-prompt-file', systemFile,
      '--mcp-config', mcpConfigPath, '--strict-mcp-config',
      ...toolArgs(code),
      '--setting-sources', '',
      '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence',
      ...(model ? ['--model', model] : []),
    ]), { cwd, stdio: ['pipe', 'pipe', 'pipe'], ...spawnOptions(),
      // which login (subscription) to use: the provider's config folder, else Claude Code's default
      ...(provider?.configDir && { env: { ...process.env, CLAUDE_CONFIG_DIR: resolveConfigDir(provider.configDir) } }) });
    claude.stdin.end(prompt);
    signal.addEventListener('abort', () => stopChild(claude));

    let buf = '', stderr = '';
    claude.stdout.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'assistant') {
          for (const c of msg.message.content) {
            if (c.type === 'text') emit('text', c.text);
            // reading the code is not a browser step: a log line, not a step in the guide
            if (c.type === 'tool_use' && !c.name.startsWith('mcp__playwright__')) emit('log', `Code: ${c.name} ${c.input.file_path ?? c.input.pattern ?? ''}`.trim());
            else if (c.type === 'tool_use') emit('tool', { name: c.name.replace('mcp__playwright__', ''), input: c.input });
          }
        } else if (msg.type === 'result') {
          if (msg.is_error) reject(new Error(msg.result || 'claude reported an error'));
          else resolve({ text: msg.result ?? '', turns: msg.num_turns });
        }
      }
    });
    claude.stderr.on('data', d => { stderr += d; });
    claude.on('error', e => reject(new Error(`Cannot start claude: ${e.message}`)));
    claude.on('close', code => reject(new Error(`claude exited (${code}) without a result. ${stderr.slice(-500)}`)));
  });
}

// Any OpenAI-compatible /chat/completions API: OpenAI, Anthropic, Gemini, OpenRouter, Groq, DeepSeek, Ollama, LM Studio…
// ponytail: plain fetch + tool-calling loop, no provider SDKs
export async function openaiCompatible({ provider, model, prompt, system, mcpServer, cwd }, emit, signal) {
  const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
  const mcp = new Client({ name: 'abra', version: '1.0.0' });
  await mcp.connect(new StdioClientTransport({ ...mcpServer, env: { ...getDefaultEnvironment(), ...mcpServer.env }, cwd, stderr: 'ignore' })); // env alone would drop PATH/HOME
  signal.addEventListener('abort', () => mcp.close());
  try {
    const { tools } = await mcp.listTools();
    const fnTools = tools.map(({ name, description, inputSchema: { $schema, ...parameters } }) =>
      ({ type: 'function', function: { name, description, parameters } }));
    const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      const toolMsgs = messages.filter(m => m.role === 'tool');
      for (const m of toolMsgs.slice(0, -KEEP_FULL_RESULTS))
        if (m.content.length > 1500) m.content = m.content.slice(0, 1500) + '\n…[older output truncated]';

      const r = await fetch(`${provider.baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey && { authorization: `Bearer ${apiKey}` }) },
        body: JSON.stringify({ model, messages, tools: fnTools }),
        signal,
      });
      if (!r.ok) throw new Error(`${provider.label} HTTP ${r.status}: ${(await r.text()).slice(0, 800)}`);
      const msg = (await r.json()).choices?.[0]?.message;
      if (!msg) throw new Error(`${provider.label}: empty response`);
      messages.push(msg);
      if (msg.content) emit('text', msg.content);
      if (!msg.tool_calls?.length) return { text: msg.content ?? '', turns: turn };

      for (const call of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
        emit('tool', { name: call.function.name, input: args });
        const out = await mcp.callTool({ name: call.function.name, arguments: args })
          .catch(e => ({ content: [{ type: 'text', text: `Error: ${e.message}` }] }));
        const text = out.content.map(c => c.type === 'text' ? c.text : `[${c.type} omitted]`).join('\n');
        messages.push({ role: 'tool', tool_call_id: call.id, content: text });
      }
    }
    throw new Error(`Stopped after ${MAX_TURNS} turns without finishing`);
  } finally {
    await mcp.close().catch(() => {});
  }
}

export const engines = { 'claude-code': claudeCode, 'openai-compatible': openaiCompatible };
