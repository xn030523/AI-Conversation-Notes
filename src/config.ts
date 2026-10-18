import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const entryPath = join(projectRoot, 'dist', 'cli.js');

export interface Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  userId: string;
  stateDir: string;
  publicUrl: string;
  bind: string;
  port: number;
  usersFile: string;
  allowedNames: string[];
}

export interface ClientConfig {
  serverUrl: string;
  token: string;
  name?: string;
  stateDir: string;
}

export function validArchiveName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(name);
}

export function archiveUrl(config: ClientConfig, path: 'mcp' | 'ingest'): string {
  const url = new URL(`${config.serverUrl}/${path}`);
  if (config.name) url.searchParams.set('name', config.name);
  return url.toString();
}

function readDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is missing; create ${join(projectRoot, '.env')}`);
  return value;
}

export function stateDirectory(): string {
  const dir = process.env.XDG_STATE_HOME
    ? join(process.env.XDG_STATE_HOME, 'rustfs-conversation-mcp')
    : join(homedir(), '.local', 'state', 'rustfs-conversation-mcp');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function installationId(stateDir: string): string {
  const path = join(stateDir, 'installation-id');
  if (!existsSync(path)) {
    try { writeFileSync(path, randomUUID(), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  return readFileSync(path, 'utf8').trim();
}

export function loadConfig(): Config {
  const envFile = process.env.RUSTFS_MCP_SERVER_ENV_FILE || join(projectRoot, '.server.env');
  const file = readDotEnv(envFile);
  const get = (key: string): string | undefined => process.env[key] || file[key];
  const stateDir = stateDirectory();
  const userId = get('ARCHIVE_USER_ID') || installationId(stateDir);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(userId)) {
    throw new Error('ARCHIVE_USER_ID must contain only letters, digits, underscores, or hyphens');
  }
  const endpoint = required(get('RUSTFS_ENDPOINT'), 'RUSTFS_ENDPOINT');
  if (!/^https?:\/\//.test(endpoint)) throw new Error('RUSTFS_ENDPOINT must be an HTTP(S) URL');
  const bucket = get('RUSTFS_BUCKET') || 'conversations';
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid RUSTFS_BUCKET');
  const allowedNames = (get('ARCHIVE_NAMES') || '').split(',').map(name => name.trim()).filter(Boolean);
  if (allowedNames.some(name => !validArchiveName(name)) || new Set(allowedNames).size !== allowedNames.length) {
    throw new Error('ARCHIVE_NAMES must contain unique, valid comma-separated names');
  }
  return {
    endpoint,
    region: get('RUSTFS_REGION') || 'us-east-1',
    bucket,
    accessKey: required(get('RUSTFS_ACCESS_KEY'), 'RUSTFS_ACCESS_KEY'),
    secretKey: required(get('RUSTFS_SECRET_KEY'), 'RUSTFS_SECRET_KEY'),
    userId,
    stateDir,
    publicUrl: required(get('ARCHIVE_PUBLIC_URL'), 'ARCHIVE_PUBLIC_URL').replace(/\/$/, ''),
    bind: get('ARCHIVE_BIND') || '127.0.0.1',
    port: Number(get('ARCHIVE_PORT') || 5080),
    usersFile: join(projectRoot, '.users.json'),
    allowedNames,
  };
}

export function loadClientConfig(): ClientConfig {
  const envFile = process.env.RUSTFS_MCP_CLIENT_ENV_FILE || join(projectRoot, '.env');
  const file = readDotEnv(envFile);
  const get = (key: string): string | undefined => process.env[key] || file[key];
  const name = get('ARCHIVE_NAME');
  if (name && !validArchiveName(name)) throw new Error('ARCHIVE_NAME must be 1-63 lowercase letters, digits, _ or -');
  return {
    serverUrl: required(get('ARCHIVE_SERVER_URL'), 'ARCHIVE_SERVER_URL').replace(/\/$/, ''),
    token: required(get('ARCHIVE_TOKEN'), 'ARCHIVE_TOKEN'),
    name,
    stateDir: stateDirectory(),
  };
}
