import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { once } from 'node:events';
import { io as createClient, type Socket } from 'socket.io-client';
import { RedisSocketIoAdapter } from './redis-socket-io.adapter';
import { SocketIoReadinessService } from './socket-io-readiness.service';

const redisUrl = process.env.REDIS_INTEGRATION_URL;
const integration = redisUrl ? describe : describe.skip;

describe('RedisSocketIoAdapter single-instance behavior', () => {
  it('keeps local-only mode explicit and reports readiness', async () => {
    const readiness = new SocketIoReadinessService();
    const adapter = new RedisSocketIoAdapter({} as never, {}, readiness);
    await adapter.initialize();
    expect(adapter.isRedisReady).toBe(false);
    expect(readiness.status).toBe('ready');
    await adapter.shutdown();
  });

  it('keeps a local Socket.IO connection functional without Redis in single-instance mode', async () => {
    const httpServer = createHttpServer();
    const adapter = new RedisSocketIoAdapter(httpServer as never);
    let server: ReturnType<RedisSocketIoAdapter['createIOServer']> | undefined;
    let client: Socket | undefined;
    try {
      await adapter.initialize();
      server = adapter.createIOServer(0, { path: '/hubs/driver', transports: ['websocket'] });
      await listen(httpServer);
      server.on('connection', (socket) => socket.emit('local-smoke', { ok: true }));
      const port = (httpServer.address() as { port: number }).port;
      client = createClient(`http://127.0.0.1:${port}`, {
        path: '/hubs/driver', transports: ['websocket'], reconnection: false,
      });
      const payload = once(client, 'local-smoke');
      await once(client, 'connect');
      await expect(payload).resolves.toEqual([{ ok: true }]);
    } finally {
      client?.disconnect();
      if (server) await adapter.close(server);
      else await adapter.shutdown();
      await closeHttpServer(httpServer);
    }
  });

  it('does not silently accept required multi-instance mode without Redis', async () => {
    const readiness = new SocketIoReadinessService();
    const adapter = new RedisSocketIoAdapter({} as never, { required: true }, readiness);
    await expect(adapter.initialize()).rejects.toThrow('REDIS_URL is not configured');
    expect(readiness.status).toBe('degraded');
  });
});

integration('RedisSocketIoAdapter cross-instance integration', () => {
  jest.setTimeout(20_000);

  it('propagates broadcasts and room-targeted events between two instances', async () => {
    const serverAHttp = createHttpServer();
    const serverBHttp = createHttpServer();
    const adapterA = new RedisSocketIoAdapter(serverAHttp as never, { redisUrl, required: true });
    const adapterB = new RedisSocketIoAdapter(serverBHttp as never, { redisUrl, required: true });
    let socketA: Socket | undefined;
    let socketB: Socket | undefined;
    let serverA: ReturnType<RedisSocketIoAdapter['createIOServer']> | undefined;
    let serverB: ReturnType<RedisSocketIoAdapter['createIOServer']> | undefined;

    try {
      await Promise.all([adapterA.initialize(), adapterB.initialize()]);
      serverA = adapterA.createIOServer(0, { path: '/hubs/driver', transports: ['websocket'] });
      serverB = adapterB.createIOServer(0, { path: '/hubs/driver', transports: ['websocket'] });
      await Promise.all([listen(serverAHttp), listen(serverBHttp)]);
      const portA = (serverAHttp.address() as { port: number }).port;
      const portB = (serverBHttp.address() as { port: number }).port;

      serverA.on('connection', (socket) => socket.join('authorized-driver-room'));
      socketA = createClient(`http://127.0.0.1:${portA}`, {
        path: '/hubs/driver', transports: ['websocket'], reconnection: false,
      });
      socketB = createClient(`http://127.0.0.1:${portB}`, {
        path: '/hubs/driver', transports: ['websocket'], reconnection: false,
      });
      await Promise.all([once(socketA, 'connect'), once(socketB, 'connect')]);

      const globalEvent = once(socketA, 'cross-instance-global');
      const roomEvent = once(socketA, 'cross-instance-room');
      let unrelatedRoomReceived = false;
      socketB.on('cross-instance-room', () => { unrelatedRoomReceived = true; });
      serverB.emit('cross-instance-global', { source: 'instance-b' });
      serverB.to('authorized-driver-room').emit('cross-instance-room', { source: 'instance-b' });

      await expect(globalEvent).resolves.toEqual([{ source: 'instance-b' }]);
      await expect(roomEvent).resolves.toEqual([{ source: 'instance-b' }]);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(unrelatedRoomReceived).toBe(false);

      const clientsA = adapterA as unknown as {
        pubClient: { disconnect(): void; connect(): Promise<unknown> };
        subClient: { disconnect(): void; connect(): Promise<unknown> };
      };
      clientsA.pubClient.disconnect();
      clientsA.subClient.disconnect();
      await waitFor(() => !adapterA.isRedisReady);
      expect(() => serverA?.emit('while-redis-down')).toThrow('refusing local-only broadcast');

      await Promise.all([clientsA.pubClient.connect(), clientsA.subClient.connect()]);
      await waitFor(() => adapterA.isRedisReady);
      const recoveredEvent = once(socketA, 'after-redis-reconnect');
      serverB.emit('after-redis-reconnect', { source: 'instance-b' });
      await expect(recoveredEvent).resolves.toEqual([{ source: 'instance-b' }]);
    } finally {
      socketA?.disconnect();
      socketB?.disconnect();
      if (serverA) await adapterA.close(serverA);
      else await adapterA.shutdown();
      if (serverB) await adapterB.close(serverB);
      else await adapterB.shutdown();
      await closeHttpServer(serverAHttp);
      await closeHttpServer(serverBHttp);
    }
  });
});

function listen(server: HttpServer): Promise<void> {
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => undefined);
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for Redis adapter state');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
