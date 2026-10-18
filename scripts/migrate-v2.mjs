import { createHash } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '../dist/config.js';
import { listUsers } from '../dist/users.js';

const config = loadConfig();
const userId = process.argv[2];
const apply = process.argv.includes('--apply');
const user = (await listUsers(config)).find(item => item.id === userId);
if (!user) throw new Error('Usage: node scripts/migrate-v2.mjs <existing-user-id> [--apply]');

const s3 = new S3Client({
  endpoint: config.endpoint, region: config.region, forcePathStyle: true,
  credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
});
const digest = value => createHash('sha256').update(value).digest('hex');
async function read(key) {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    return await result.Body.transformToString();
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

try {
  let continuationToken;
  const keys = [];
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: config.bucket, MaxKeys: 1000, ContinuationToken: continuationToken,
    }));
    keys.push(...(page.Contents || []).map(item => item.Key).filter(key => /^[a-zA-Z0-9_-]+\.json$/.test(key)));
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  console.log(`${keys.length} root-level conversations; ${apply ? 'migrating' : 'preview only'}`);

  for (const key of keys) {
    const source = JSON.parse(await read(key));
    const sessionId = key.slice(0, -5);
    if (source.schema_version !== 2 || source.session_id !== sessionId) throw new Error(`Unexpected legacy format: ${key}`);
    const destination = `users/${user.id}/${key}`;
    const converted = JSON.stringify({ ...source, schema_version: 3, user_id: user.id, display_name: user.display_name });
    const existing = await read(destination);
    if (existing !== null && digest(existing) !== digest(converted)) throw new Error(`Destination differs: ${destination}`);
    console.log(`${key} -> ${destination}`);
    if (!apply) continue;
    if (existing === null) await s3.send(new PutObjectCommand({
      Bucket: config.bucket, Key: destination, Body: converted, ContentType: 'application/json',
    }));
    if (digest(await read(destination)) !== digest(converted)) throw new Error(`Verification failed: ${destination}`);
    await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
  }
} finally {
  s3.destroy();
}
