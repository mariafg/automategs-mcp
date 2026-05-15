import net from 'net';
import { PORT_RANGE_START, PORT_RANGE_END } from './constants.js';

function testPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

export async function findAvailablePort(
  start = PORT_RANGE_START,
  end = PORT_RANGE_END,
): Promise<number> {
  for (let port = start; port <= end; port++) {
    if (await testPort(port)) {
      return port;
    }
  }
  throw new Error(`No available port found in range ${start}-${end}`);
}
