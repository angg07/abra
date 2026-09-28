// Which Claude Code login a provider uses: its config folder (CLAUDE_CONFIG_DIR), e.g. ~/.claude-2 for a second
// account. Empty = Claude Code's default. The signed-in account is recorded in <folder>/.claude.json
// (~/.claude.json for the default), so Settings can show whose subscription a run will use.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export function resolveConfigDir(input, home = homedir()) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const dir = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
  if (!isAbsolute(dir)) throw new Error(`Config folder "${raw}": give the full path, e.g. ~/.claude-2`);
  if (!existsSync(dir)) throw new Error(`Config folder ${raw} does not exist`);
  if (!statSync(dir).isDirectory()) throw new Error(`Config folder ${raw} is not a folder`);
  return dir;
}

export function claudeAccount(configDir, home = homedir()) {
  try {
    const { oauthAccount: a } = JSON.parse(readFileSync(configDir ? join(configDir, '.claude.json') : join(home, '.claude.json'), 'utf8'));
    return a?.emailAddress ? { email: a.emailAddress, org: a.organizationName ?? '' } : null;
  } catch { return null; } // no file yet: never signed in with this folder
}
