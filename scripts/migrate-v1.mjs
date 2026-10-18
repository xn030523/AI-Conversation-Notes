import { createHash } from 'node:crypto';
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '../dist/config.js';

const config = loadConfig();
const apply = process.argv.includes('--apply');
const s3 = new S3Client({
  endpoint: config.endpoint,
  region: config.region,
  forcePathStyle: true,
  credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
});

async function object(key) {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    return JSON.parse(await result.Body.transformToString());
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

const oldKeys = [];
let continuationToken;
do {
  const page = await s3.send(new ListObjectsV2Command({
    Bucket: config.bucket, Prefix: 'v1/', MaxKeys: 1000, ContinuationToken: continuationToken,
  }));
  for (const item of page.Contents || []) if (item.Key?.endsWith('.json')) oldKeys.push(item.Key);
  continuationToken = page.NextContinuationToken;
} while (continuationToken);

const groups = new Map();
for (const key of oldKeys) {
  const record = await object(key);
  if (!record || record.schema_version !== 1 || !record.session_id) throw new Error(`Invalid legacy object: ${key}`);
  const list = groups.get(record.session_id) || [];
  list.push({ key, record });
  groups.set(record.session_id, list);
}

console.log(`Legacy objects: ${oldKeys.length}; conversations: ${groups.size}; mode: ${apply ? 'apply' : 'preview'}`);
for (const [sessionId, entries] of groups) {
  const destination = `${sessionId}.json`;
  const existing = await object(destination);
  if (existing && existing.schema_version !== 2) throw new Error(`Unexpected target format: ${destination}`);
  const client = entries[0].record.client;
  if (entries.some(({ record }) => record.client !== client)) throw new Error(`Mixed clients for ${sessionId}`);
  if (existing && existing.client !== client) throw new Error(`Client mismatch for ${sessionId}`);
  const events = existing?.events || [];
  const known = new Set(events.map(event => event.event_id));
  let transcript = existing?.transcript || null;
  let hash = existing?.transcript_sha256 || null;
  let updatedAt = existing?.updated_at || '';
  for (const { key, record } of entries.sort((a,b) => a.record.captured_at.localeCompare(b.record.captured_at))) {
    const eventId = createHash('sha256').update(key).digest('hex');
    if (!known.has(eventId)) {
      events.push({
        event_id: eventId,
        event: record.event,
        captured_at: record.captured_at,
        transcript_error: record.transcript_error || null,
        hook: record.hook,
      });
      known.add(eventId);
    }
    if (record.transcript !== null && (!transcript || record.transcript.length >= transcript.length)) {
      transcript = record.transcript;
      hash = record.transcript_sha256;
    }
    if (record.captured_at > updatedAt) updatedAt = record.captured_at;
  }
  events.sort((a,b) => a.captured_at.localeCompare(b.captured_at));
  const merged = { schema_version: 2, client, session_id: sessionId, updated_at: updatedAt,
    transcript, transcript_sha256: hash, events };
  console.log(`${destination}: ${entries.length} old objects, ${events.length} events, ${transcript?.length || 0} transcript characters`);
  if (!apply) continue;
  await s3.send(new PutObjectCommand({ Bucket: config.bucket, Key: destination,
    Body: JSON.stringify(merged), ContentType: 'application/json' }));
  const verified = await object(destination);
  if (!verified || verified.session_id !== sessionId || verified.events.length !== events.length ||
      verified.transcript_sha256 !== hash) throw new Error(`Verification failed: ${destination}`);
  for (const { key } of entries) await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
}
s3.destroy();
