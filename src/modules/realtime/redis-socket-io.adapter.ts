import { Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import type { INestApplication } from '@nestjs/common';
import { SocketIoReadinessService } from './socket-io-readiness.service';

export type RedisSocketIoAdapterOptions = {
  redisUrl?: string;
  required?: boolean;
  connectTimeoutMs?: number;
};

/**
 * Shares Socket.IO broadcasts between backend instances while keeping each
 * existing /hubs/* gateway on its own Redis channel prefix.
 */
export class RedisSocketIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisSocketIoAdapter.name);
  private readonly servers = new Set<Server>();
  private pubClient?: Redis;
  private subClient?: Redis;
  private redisReady = false;
  private closing = false;

  constructor(
    app: INestApplication,
    options: RedisSocketIoAdapterOptions = {},
    private readonly readiness?: SocketIoReadinessService,
  ) {
    super(app);
    this.redisUrl = options.redisUrl?.trim();
    this.required = options.required ?? false;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.readiness?.configure(this.required, Boolean(this.redisUrl));
  }

  private readonly redisUrl?: string;
  private readonly required: boolean;
  private readonly connectTimeoutMs: number;

  get isRedisReady(): boolean {
    return this.redisReady && this.pubClient?.status === 'ready' && this.subClient?.status === 'ready';
  }

  get isRequired(): boolean {
    return this.required;
  }

  async initialize(): Promise<void> {
    if (!this.redisUrl) {
      if (this.required) {
        throw new Error('SOCKET_IO_REDIS_REQUIRED is enabled but REDIS_URL is not configured');
      }
      this.logger.warn('REDIS_URL is unset; Socket.IO is local to this instance only');
      this.readiness?.setRedisReady(false);
      return;
    }

    const clientOptions = {
      lazyConnect: true,
      enableReadyCheck: true,
      maxRetriesPerRequest: null,
      retryStrategy: (attempt: number) => Math.min(1_000 * attempt, 10_000),
    };
    this.pubClient = new Redis(this.redisUrl, clientOptions);
    this.subClient = this.pubClient.duplicate();
    this.watchClient(this.pubClient, 'publisher');
    this.watchClient(this.subClient, 'subscriber');

    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([this.pubClient.connect(), this.subClient.connect()]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Redis connection did not become ready within ${this.connectTimeoutMs}ms`)),
            this.connectTimeoutMs,
          );
          timeout.unref?.();
        }),
      ]);
      this.updateReadiness();
      if (!this.isRedisReady) throw new Error('Redis clients did not reach ready state');
    } catch (error) {
      await this.closeRedisClients();
      if (this.required) {
        throw new Error('Required Socket.IO Redis adapter could not connect', { cause: error });
      }
      throw new Error('REDIS_URL is configured but Socket.IO Redis could not connect; refusing local-only fallback', {
        cause: error,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    this.servers.add(server);
    if (this.pubClient && this.subClient) {
      const path = options?.path ?? '/socket.io';
      const key = `shuttlez:${encodeURIComponent(path)}`;
      const adapterFactory = createAdapter(this.pubClient, this.subClient, { key });
      server.adapter((namespace) => {
        const adapter = adapterFactory(namespace);
        const broadcast = adapter.broadcast.bind(adapter);
        adapter.broadcast = (packet, broadcastOptions) => {
          if (!this.isRedisReady) {
            throw new Error('Socket.IO Redis adapter is unavailable; refusing local-only broadcast');
          }
          return broadcast(packet, broadcastOptions);
        };
        return adapter;
      });
    }
    return server;
  }

  async close(server: Server): Promise<void> {
    await super.close(server);
    this.servers.delete(server);
    if (this.servers.size === 0) await this.closeRedisClients();
  }

  async shutdown(): Promise<void> {
    await this.closeRedisClients();
  }

  private watchClient(client: Redis, name: 'publisher' | 'subscriber'): void {
    client.on('ready', () => {
      this.updateReadiness();
      this.logger.log(`Socket.IO Redis ${name} ready`);
    });
    client.on('close', () => {
      this.updateReadiness();
      this.logger.warn(`Socket.IO Redis ${name} connection closed; cross-instance delivery unavailable`);
    });
    client.on('reconnecting', (delay: number) => {
      this.updateReadiness();
      this.logger.warn(`Socket.IO Redis ${name} reconnecting in ${delay}ms`);
    });
    client.on('error', (error: Error) => {
      this.logger.error(`Socket.IO Redis ${name} error: ${error.message}`);
    });
  }

  private updateReadiness(): void {
    const ready = this.pubClient?.status === 'ready' && this.subClient?.status === 'ready';
    const wasReady = this.redisReady;
    this.redisReady = ready;
    this.readiness?.setRedisReady(ready);
    if (ready && !wasReady) {
      this.logger.log('Socket.IO Redis adapter is ready for cross-instance delivery');
    }
  }

  private async closeRedisClients(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.redisReady = false;
    this.readiness?.setRedisReady(false);
    const clients = [this.pubClient, this.subClient].filter(
      (client): client is Redis => client !== undefined,
    );
    this.pubClient = undefined;
    this.subClient = undefined;
    await Promise.all(
      clients.map(async (client) => {
        try {
          if (client.status === 'ready') await client.quit();
          else client.disconnect();
        } catch (error) {
          this.logger.warn(`Socket.IO Redis shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
          client.disconnect();
        }
      }),
    );
  }
}
