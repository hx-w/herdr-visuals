import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const PLUGIN = 'hx-w.visuals';
export function socketPath() {
  if (!process.env.HERDR_SOCKET_PATH) throw new Error('Run inside a Herdr pane (HERDR_SOCKET_PATH is missing).');
  return process.env.HERDR_SOCKET_PATH;
}
export function stateDir() {
  const session = createHash('sha256').update(socketPath()).digest('hex').slice(0, 16);
  return path.join(process.env.HERDR_PLUGIN_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'herdr-visuals'), session);
}
export function rpc(method, params = {}, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = net.createConnection(socketPath());
    let buffer = '';
    const finish = (error, value) => { socket.destroy(); error ? reject(error) : resolve(value); };
    socket.setTimeout(timeout, () => finish(new Error(`${method}: Herdr timed out`)));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
    socket.setEncoding('utf8');
    socket.on('data', data => {
      buffer += data;
      if (buffer.length > 16 * 1024 * 1024) return finish(new Error('Herdr response exceeded 16 MiB'));
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const response = JSON.parse(line);
          if (response.id !== id) continue;
          if (response.error) return finish(new Error(`${method}: ${response.error.message || JSON.stringify(response.error)}`));
          finish(null, response.result);
        } catch (error) { finish(error); }
      }
    });
    socket.on('end', () => finish(new Error(`${method}: Herdr disconnected`)));
  });
}
