import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { archiveUrl, entryPath, type ClientConfig } from './config.js';

type ClientName = 'codex' | 'claude';
const serverName = 'rustfs-conversations';
const events = ['UserPromptSubmit', 'Stop', 'SessionEnd'];

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

async function addHooks(client: ClientName): Promise<string> {
  const path = client === 'codex'
    ? join(homedir(), '.codex', 'hooks.json')
    : join(homedir(), '.claude', 'settings.json');
  await mkdir(join(homedir(), client === 'codex' ? '.codex' : '.claude'), { recursive: true });
  const exists = existsSync(path);
  const data = exists ? JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> : {};
  if (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks)) data.hooks = {};
  const hooks = data.hooks as Record<string, unknown>;
  const command = `${shellQuote(process.execPath)} ${shellQuote(entryPath)} hook ${client}`;
  let changed = false;
  for (const event of events) {
    if (!Array.isArray(hooks[event])) hooks[event] = [];
    const groups = hooks[event] as Array<{ hooks?: Array<{ type?: string; command?: string; timeout?: number }> }>;
    const existing = groups.flatMap(group => group.hooks || []).find(handler => handler.command === command);
    if (existing) {
      if (existing.timeout !== 10) { existing.timeout = 10; changed = true; }
      continue;
    }
    groups.push({ hooks: [{ type: 'command', command, timeout: 10 }] });
    changed = true;
  }
  if (changed) {
    if (exists) await writeFile(`${path}.backup-${Date.now()}`, await readFile(path), { mode: 0o600 });
    await writeFile(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  }
  return path;
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

async function addClaudeMcpJson(config: ClientConfig): Promise<string> {
  const path = join(homedir(), '.claude.json');
  const exists = existsSync(path);
  const data = exists ? JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> : {};
  if (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) data.mcpServers = {};
  const servers = data.mcpServers as Record<string, unknown>;
  const desired = {
    type: 'http',
    url: archiveUrl(config, 'mcp'),
    headersHelper: `${shellQuote(process.execPath)} ${shellQuote(entryPath)} headers`,
  };
  if (JSON.stringify(servers[serverName]) !== JSON.stringify(desired)) {
    servers[serverName] = desired;
    if (exists) await writeFile(`${path}.backup-${Date.now()}`, await readFile(path), { mode: 0o600 });
    await writeFile(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  }
  return path;
}

async function addCodexHeaderHelper(): Promise<void> {
  const path = join(homedir(), '.codex', 'config.toml');
  const source = await readFile(path, 'utf8');
  const header = `[mcp_servers.${serverName}]`;
  const start = source.indexOf(header);
  if (start < 0) throw new Error(`Missing ${header} in ${path}`);
  const bodyStart = start + header.length;
  const next = source.slice(bodyStart).search(/^\[/m);
  const bodyEnd = next < 0 ? source.length : bodyStart + next;
  const oldBody = source.slice(bodyStart, bodyEnd);
  const helper = `${shellQuote(process.execPath)} ${shellQuote(entryPath)} headers`;
  const line = `http_headers_helper = ${JSON.stringify(helper)}`;
  const body = /^http_headers_helper\s*=.*$/m.test(oldBody)
    ? oldBody.replace(/^http_headers_helper\s*=.*$/m, line)
    : `\n${line}${oldBody}`;
  if (body === oldBody) return;
  await writeFile(`${path}.backup-${Date.now()}`, source, { mode: 0o600 });
  await writeFile(path, source.slice(0, bodyStart) + body + source.slice(bodyEnd), { mode: 0o600 });
}

export async function install(client: ClientName, config: ClientConfig): Promise<void> {
  if (client === 'codex') {
    const check = spawnSync('codex', ['mcp', 'get', serverName], { stdio: 'ignore' });
    if (check.error) throw check.error;
    if (check.status === 0) run('codex', ['mcp', 'remove', serverName]);
    run('codex', ['mcp', 'add', serverName, '--url', archiveUrl(config, 'mcp')]);
    await addCodexHeaderHelper();
  } else {
    const path = await addClaudeMcpJson(config);
    process.stdout.write(`Claude Code MCP configured in ${path}\n`);
  }
  const path = await addHooks(client);
  process.stdout.write(`Configured ${client} MCP and hooks in ${path}\n`);
  if (client === 'codex') process.stdout.write('In Codex, open /hooks and trust the new command hooks.\n');
}
