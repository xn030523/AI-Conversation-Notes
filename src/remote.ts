import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { validArchiveName, type Config } from './config.js';
import { SessionStore, validEvent, validSessionId } from './sessionStore.js';
import { authenticate, type ArchiveUser } from './users.js';

function respond(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function bodyJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const part of request) {
    const chunk = Buffer.from(part);
    length += chunk.length;
    if (length > 64 * 1024 * 1024) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const compressed = Buffer.concat(chunks);
  const encoding = request.headers['content-encoding'];
  if (encoding && encoding !== 'gzip') throw new Error('Unsupported content encoding');
  const body = encoding === 'gzip'
    ? gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 })
    : compressed;
  return JSON.parse(body.toString('utf8')) as unknown;
}

function mcpServer(user: ArchiveUser, store: SessionStore): McpServer {
  const server = new McpServer({ name: 'rustfs-conversations', version: '0.2.0' });
  server.registerTool('archive_status', {
    description: 'Show your archive identity and number of saved conversations.',
  }, async () => {
    const sessions = await store.list(user);
    return { content: [{ type: 'text', text: JSON.stringify({
      user_id: user.id, display_name: user.display_name, conversations: sessions.length,
    }) }] };
  });
  server.registerTool('archive_list', {
    description: 'List your archived conversation IDs and last update times.',
  }, async () => ({ content: [{ type: 'text', text: JSON.stringify(await store.list(user)) }] }));
  server.registerTool('archive_read', {
    description: 'Read one of your archived conversations by session ID.',
    inputSchema: { session_id: z.string() },
  }, async ({ session_id }) => {
    if (!validSessionId(session_id)) return { isError: true, content: [{ type: 'text', text: 'Invalid session ID' }] };
    const record = await store.get(user, session_id);
    return record
      ? { content: [{ type: 'text', text: JSON.stringify(record) }] }
      : { isError: true, content: [{ type: 'text', text: 'Conversation not found' }] };
  });
  return server;
}

export async function serve(config: Config): Promise<void> {
  const store = new SessionStore(config);
  const http = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    const path = url.pathname;
    if (path === '/health' && request.method === 'GET') {
      respond(response, 200, { ok: true });
      return;
    }
    if (path !== '/mcp' && path !== '/ingest') {
      respond(response, 404, { error: 'not_found' });
      return;
    }
    try {
      const authenticated = await authenticate(config, request);
      if (!authenticated) { respond(response, 401, { error: 'unauthorized' }); return; }
      const names = url.searchParams.getAll('name');
      if (names.length > 1 || (names.length === 1 && !validArchiveName(names[0]))) {
        respond(response, 400, { error: 'invalid_name' }); return;
      }
      const user = names.length === 1
        ? { ...authenticated, id: names[0], display_name: names[0] }
        : authenticated;
      if (config.allowedNames.length && !config.allowedNames.includes(user.id)) {
        respond(response, 403, { error: 'name_not_allowed' }); return;
      }
      if (path === '/ingest') {
        if (request.method !== 'POST') { respond(response, 405, { error: 'method_not_allowed' }); return; }
        const body = await bodyJson(request);
        if (!validEvent(body)) { respond(response, 400, { error: 'invalid_event' }); return; }
        await store.ingest(user, body);
        respond(response, 200, { saved: true, session_id: body.session_id });
        return;
      }
      if (request.method !== 'POST') { respond(response, 405, { error: 'method_not_allowed' }); return; }
      const mcp = mcpServer(user, store);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport);
      response.on('close', () => { void transport.close(); void mcp.close(); });
      await transport.handleRequest(request, response);
    } catch (error) {
      process.stderr.write(`Request failed: ${(error as Error).message}\n`);
      if (!response.headersSent) respond(response, 500, { error: 'server_error' });
      else response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.port, config.bind, resolve);
  });
  process.stdout.write(`Archive MCP listening on ${config.bind}:${config.port}\n`);
}
