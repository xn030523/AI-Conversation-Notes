import { loadClientConfig, loadConfig } from './config.js';
import { flush, pending } from './clientQueue.js';
import { handleHook } from './hook.js';
import { install } from './install.js';
import { serve } from './remote.js';
import { SessionStore } from './sessionStore.js';
import { addUser, listUsers } from './users.js';

async function main(): Promise<void> {
  const [command, client] = process.argv.slice(2);
  if (command === 'install') {
    if (client !== 'codex' && client !== 'claude') throw new Error('Usage: install codex|claude');
    await install(client, loadClientConfig());
  } else if (command === 'hook') {
    if (client !== 'codex' && client !== 'claude') throw new Error('Usage: hook codex|claude');
    try { await handleHook(client, loadClientConfig()); }
    catch (error) { process.stderr.write(`Archive hook error: ${(error as Error).message}\n`); }
    process.stdout.write('{}\n');
  } else if (command === 'headers') {
    const config = loadClientConfig();
    process.stdout.write(JSON.stringify({ Authorization: `Bearer ${config.token}` }) + '\n');
  } else if (command === 'serve') {
    await serve(loadConfig());
  } else if (command === 'init') {
    const config = loadConfig();
    const store = new SessionStore(config);
    try { await store.init(); } finally { store.close(); }
    process.stdout.write(`Bucket ${config.bucket} is ready on ${config.endpoint}\n`);
  } else if (command === 'sync') {
    process.stdout.write(JSON.stringify(await flush(loadClientConfig(), 1000, 30_000)) + '\n');
  } else if (command === 'status') {
    const config = loadClientConfig();
    process.stdout.write(JSON.stringify({ server: config.serverUrl, pending: await pending(config) }) + '\n');
  } else if (command === 'user') {
    const config = loadConfig();
    if (client === 'list') process.stdout.write(JSON.stringify(await listUsers(config), null, 2) + '\n');
    else if (client === 'add') {
      const id = process.argv[4];
      if (!id) throw new Error('Usage: user add <id> [--name display-name] [--out client-env-path]');
      const nameAt = process.argv.indexOf('--name');
      const outAt = process.argv.indexOf('--out');
      await addUser(config, id, nameAt < 0 ? id : process.argv[nameAt + 1], outAt < 0 ? undefined : process.argv[outAt + 1]);
    } else throw new Error('Usage: user add|list');
  } else {
    process.stdout.write('Usage: node dist/cli.js init|serve|user add|user list|install codex|install claude|hook codex|hook claude|headers|sync|status\n');
  }
}

main().catch(error => { process.stderr.write(`${(error as Error).stack || error}\n`); process.exitCode = 1; });
