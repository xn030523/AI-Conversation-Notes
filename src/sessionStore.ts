import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Config } from './config.js';
import type { ArchiveUser } from './users.js';

export interface IncomingEvent {
  event_id: string;
  client: 'codex' | 'claude';
  session_id: string;
  event: string;
  captured_at: string;
  transcript: string | null;
  transcript_sha256: string | null;
  transcript_error: string | null;
  hook: Record<string, unknown>;
}

interface SessionRecord {
  schema_version: 3;
  user_id: string;
  display_name: string;
  client: string;
  session_id: string;
  updated_at: string;
  transcript: string | null;
  transcript_sha256: string | null;
  events: Array<Omit<IncomingEvent, 'client' | 'session_id' | 'transcript' | 'transcript_sha256'>>;
}

export function validSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(id);
}

export function validEvent(value: unknown): value is IncomingEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<IncomingEvent>;
  return typeof event.event_id === 'string' && event.event_id.length <= 100 &&
    (event.client === 'codex' || event.client === 'claude') &&
    validSessionId(event.session_id) && typeof event.event === 'string' && event.event.length <= 80 &&
    typeof event.captured_at === 'string' &&
    (event.transcript === null || typeof event.transcript === 'string') &&
    (event.transcript_sha256 === null || typeof event.transcript_sha256 === 'string') &&
    (event.transcript_error === null || typeof event.transcript_error === 'string') &&
    !!event.hook && typeof event.hook === 'object' && !Array.isArray(event.hook);
}

export class SessionStore {
  private s3: S3Client;
  private locks = new Map<string, Promise<void>>();

  constructor(private config: Config) {
    this.s3 = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      maxAttempts: 2,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    });
  }

  async init(): Promise<void> {
    try { await this.s3.send(new HeadBucketCommand({ Bucket: this.config.bucket })); }
    catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
      await this.s3.send(new CreateBucketCommand({ Bucket: this.config.bucket }));
    }
  }

  private key(user: ArchiveUser, sessionId: string): string {
    if (!validSessionId(sessionId)) throw new Error('Invalid session ID');
    return `users/${user.id}/${sessionId}.json`;
  }

  async get(user: ArchiveUser, sessionId: string): Promise<SessionRecord | null> {
    try {
      const result = await this.s3.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: this.key(user, sessionId) }));
      const body = await result.Body?.transformToString();
      if (!body) throw new Error('Empty session object');
      const parsed = JSON.parse(body) as SessionRecord;
      if (parsed.schema_version !== 3 || parsed.user_id !== user.id || parsed.session_id !== sessionId) {
        throw new Error('Session object identity mismatch');
      }
      return parsed;
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }

  private async write(user: ArchiveUser, event: IncomingEvent): Promise<void> {
    const current = await this.get(user, event.session_id);
    if (current && current.client !== event.client) throw new Error('Session ID belongs to another client');
    const record: SessionRecord = current || {
      schema_version: 3,
      user_id: user.id,
      display_name: user.display_name,
      client: event.client,
      session_id: event.session_id,
      updated_at: event.captured_at,
      transcript: null,
      transcript_sha256: null,
      events: [],
    };
    if (!record.events.some(existing => existing.event_id === event.event_id)) {
      const { client: _client, session_id: _session, transcript: _transcript,
        transcript_sha256: _hash, ...savedEvent } = event;
      record.events.push(savedEvent);
    }
    if (event.transcript !== null &&
        (record.transcript === null || event.transcript.length >= record.transcript.length)) {
      record.transcript = event.transcript;
      record.transcript_sha256 = event.transcript_sha256;
    }
    if (event.captured_at > record.updated_at) record.updated_at = event.captured_at;
    await this.s3.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: this.key(user, event.session_id),
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }));
  }

  async ingest(user: ArchiveUser, event: IncomingEvent): Promise<void> {
    const key = this.key(user, event.session_id);
    const previous = this.locks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.write(user, event));
    this.locks.set(key, next);
    try { await next; }
    finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }

  async list(user: ArchiveUser): Promise<Array<{ session_id: string; size: number; updated_at: string }>> {
    const results: Array<{ session_id: string; size: number; updated_at: string }> = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: `users/${user.id}/`,
        MaxKeys: 1000,
        ContinuationToken: token,
      }));
      for (const item of page.Contents || []) {
        const file = item.Key?.split('/').at(-1) || '';
        if (file.endsWith('.json')) results.push({
          session_id: file.slice(0, -5),
          size: item.Size || 0,
          updated_at: item.LastModified?.toISOString() || '',
        });
      }
      token = page.NextContinuationToken;
    } while (token);
    return results.sort((a,b) => b.updated_at.localeCompare(a.updated_at));
  }

  close(): void { this.s3.destroy(); }
}
