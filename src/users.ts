import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { Config } from './config.js';

export interface ArchiveUser {
  id: string;
  display_name: string;
  token_hash: string;
  created_at: string;
}

async function readUsers(config: Config): Promise<ArchiveUser[]> {
  if (!existsSync(config.usersFile)) return [];
  const parsed: unknown = JSON.parse(await readFile(config.usersFile, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('Invalid user registry');
  return parsed as ArchiveUser[];
}

export async function listUsers(config: Config): Promise<Array<Omit<ArchiveUser, 'token_hash'>>> {
  return (await readUsers(config)).map(({ token_hash: _hash, ...user }) => user);
}

export async function addUser(config: Config, id: string, displayName: string, outputPath?: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(id)) throw new Error('User ID must be 2-63 lowercase letters, digits, _ or -');
  if (!displayName || displayName.length > 100) throw new Error('Display name must be 1-100 characters');
  if (outputPath && existsSync(outputPath)) throw new Error(`Client settings already exist: ${outputPath}`);
  const users = await readUsers(config);
  if (users.some(user => user.id === id)) throw new Error(`User ${id} already exists`);
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  users.push({ id, display_name: displayName, token_hash: tokenHash, created_at: new Date().toISOString() });
  const tmp = `${config.usersFile}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(users, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(tmp, config.usersFile);
  if (outputPath) {
    const body = `ARCHIVE_SERVER_URL=${config.publicUrl}\nARCHIVE_TOKEN=${token}\n`;
    await writeFile(outputPath, body, { mode: 0o600, flag: 'wx' });
    process.stdout.write(`Created user ${id}; client settings saved to ${outputPath}\n`);
  } else {
    process.stdout.write(`Created user ${id}; token: ${token}\n`);
  }
}

export async function authenticate(config: Config, request: IncomingMessage): Promise<ArchiveUser | null> {
  const header = request.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{30,})$/.exec(header) : null;
  if (!match) return null;
  const supplied = createHash('sha256').update(match[1]).digest();
  const users = await readUsers(config);
  for (const user of users) {
    const stored = Buffer.from(user.token_hash, 'hex');
    if (stored.length === supplied.length && timingSafeEqual(stored, supplied)) return user;
  }
  return null;
}
