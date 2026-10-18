import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ClientConfig } from './config.js';
import { enqueue, flush } from './clientQueue.js';

type ClientName = 'codex' | 'claude';

async function stdinJson(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hook input must be a JSON object');
  return value as Record<string, unknown>;
}

function safeSessionId(raw: unknown): string {
  const value = typeof raw === 'string' && raw ? raw : randomUUID();
  if (/^[a-zA-Z0-9_-]{1,120}$/.test(value)) return value;
  return createHash('sha256').update(value).digest('hex');
}

export async function handleHook(client: ClientName, config: ClientConfig): Promise<void> {
  const hook = await stdinJson();
  const sessionId = safeSessionId(hook.session_id);
  const eventName = String(hook.hook_event_name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const transcriptPath = hook.agent_transcript_path || hook.transcript_path;
  let transcript: string | null = null;
  let transcriptError: string | null = null;
  if (typeof transcriptPath === 'string' && transcriptPath) {
    try { transcript = await readFile(transcriptPath, 'utf8'); }
    catch (error) { transcriptError = (error as Error).message; }
  }
  const capturedAt = new Date().toISOString();
  const record = {
    event_id: randomUUID(),
    client,
    session_id: sessionId,
    event: eventName,
    captured_at: capturedAt,
    transcript_sha256: transcript === null ? null : createHash('sha256').update(transcript).digest('hex'),
    transcript_error: transcriptError,
    transcript,
    hook,
  };
  await enqueue(config, record);
  try { await flush(config, 2); }
  catch (error) { process.stderr.write(`RustFS upload queued: ${(error as Error).message}\n`); }
}
