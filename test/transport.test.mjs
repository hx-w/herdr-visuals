import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rpc } from '../src/herdr.mjs';

test('RPC sends boundary-sized requests and rejects oversized ones before connecting', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'visuals-rpc-'));
  const previous = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = path.join(dir, 'api.sock');
  let connections = 0, receivedBytes = 0;
  const server = net.createServer(socket => {
    connections++;
    let buffer = '';
    socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      receivedBytes = Buffer.byteLength(buffer.slice(0, end));
      const request = JSON.parse(buffer.slice(0, end));
      socket.end(JSON.stringify({ id: request.id, result: { ok: true } }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(process.env.HERDR_SOCKET_PATH, resolve));
  try {
    const method = 'pane.get', params = { pane_id: 'viewer', padding: '' };
    const overhead = Buffer.byteLength(JSON.stringify({ id: '0'.repeat(36), method, params }));
    params.padding = 'x'.repeat(1048576 - overhead);
    assert.deepEqual(await rpc(method, params), { ok: true });
    assert.equal(receivedBytes, 1048576);
    await assert.rejects(rpc(method, { ...params, padding: params.padding + 'x' }), /pane.get: request exceeds Herdr's 1 MiB limit/);
    // A character count would miss the extra UTF-8 bytes.
    await assert.rejects(rpc(method, { ...params, padding: params.padding.slice(1) + '图' }), /1 MiB limit/);
    assert.equal(connections, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
