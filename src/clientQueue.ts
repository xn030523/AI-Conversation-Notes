import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { archiveUrl, type ClientConfig } from './config.js';
import type { IncomingEvent } from './sessionStore.js';

function directory(config: ClientConfig): string { return join(config.stateDir, 'queue'); }

export async function enqueue(config: ClientConfig, event: IncomingEvent): Promise<void> {
  const dir = directory(config);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${randomUUID()}.json`;
  const temporary = join(dir, `.${name}.tmp`);
  await writeFile(temporary, JSON.stringify(event), { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(dir, name));
}

export async function pending(config: ClientConfig): Promise<number> {
  try { return (await readdir(directory(config))).filter(name => name.endsWith('.json')).length; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function lock(config: ClientConfig): Promise<(() => Promise<void>) | null> {
  const path = join(config.stateDir, 'flush.lock');
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let age: number;
    try { age = Date.now() - (await stat(path)).mtimeMs; }
    catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw statError;
    }
    if (age < 30_000) return null;
    await rm(path, { force: true });
    file = await open(path, 'wx', 0o600);
  }
  return async () => { await file.close(); await rm(path, { force: true }); };
}

export async function flush(config: ClientConfig, limit = 8, timeoutMs = 8000): Promise<{ uploaded: number; pending: number }> {
  const release = await lock(config);
  if (!release) return { uploaded: 0, pending: await pending(config) };
  let uploaded = 0;
  try {
    while (uploaded < limit) {
      const files = (await readdir(directory(config)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      })).filter(name => name.endsWith('.json')).sort();
      if (!files.length) break;
      const path = join(directory(config), files[0]);
      let payload: string;
      try { payload = await readFile(path, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const body = Buffer.byteLength(payload) > 64 * 1024 ? gzipSync(payload, { level: 3 }) : payload;
      const response = await fetch(archiveUrl(config, 'ingest'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
          ...(Buffer.isBuffer(body) ? { 'Content-Encoding': 'gzip' } : {}),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Archive server returned HTTP ${response.status}`);
      await rm(path);
      uploaded++;
    }
  } finally { await release(); }
  return { uploaded, pending: await pending(config) };
}
