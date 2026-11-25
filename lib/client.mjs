// Palm's JSON-RPC client: the same MCP server agents connect to (https://www.yuzool.com/palm/mcp), over plain HTTP.
// Key: PALM_KEY, else ~/.config/palm/key (written by `palm login`, mode 0600). Server: PALM_SERVER (for testing).
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const SERVER = () => process.env.PALM_SERVER || 'https://www.yuzool.com/palm/mcp';
export const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'palm');
const keyFile = () => join(configDir(), 'key');

export function readKey() {
  if (process.env.PALM_KEY) return process.env.PALM_KEY.trim();
  try { return readFileSync(keyFile(), 'utf8').trim(); } catch { return ''; }
}
export function saveKey(key) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(keyFile(), key.trim() + '\n', { mode: 0o600 });
  chmodSync(keyFile(), 0o600);
  return keyFile();
}
export function forgetKey() { const f = keyFile(); const had = existsSync(f); rmSync(f, { force: true }); return had; }

let nextId = 1;
export async function rpc(method, params = {}, { key = readKey(), fetch: f = globalThis.fetch } = {}) {
  const res = await f(SERVER(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'palm-cli/0.1', ...(key ? { authorization: 'Bearer ' + key } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  if (res.status === 401) throw Object.assign(new Error('Palm needs a Pro key for this. Run `palm login` or set PALM_KEY. About Pro: https://www.yuzool.com/palm/#pro'), { code: 3 });
  if (!res.ok) throw Object.assign(new Error(`Palm answered ${res.status}.`), { code: 4 });
  const j = await res.json();
  if (j.error) throw Object.assign(new Error(j.error.message || 'Palm error'), { code: 4 });
  return j.result;
}

// A tool call's text, and whether Palm said it's a Pro sheet/tool the key doesn't open.
export async function callTool(name, args = {}, opts) {
  const r = await rpc('tools/call', { name, arguments: args }, opts);
  const text = (r.content || []).map((c) => c.text || '').join('\n');
  return { text, isError: !!r.isError, locked: /is part of Palm Pro/.test(text) };
}
