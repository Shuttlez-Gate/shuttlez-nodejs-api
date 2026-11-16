import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Server } from 'socket.io';
import { io, Socket } from 'socket.io-client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { SupportChatGateway } from './realtime.gateway';
import { SocketIdentity } from './socket-identity';

const secret = 'support-chat-test-secret';

describe('Support chat Socket.IO', () => {
  let app: INestApplication;
  let gateway: SupportChatGateway;
  let jwt: JwtService;
  const open: Socket[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_SECRET: secret,
              JWT_ISSUER: 'Shuttlez',
              JWT_AUDIENCE: 'ShuttlezApp',
            }),
          ],
        }),
        JwtModule.register({
          secret,
          signOptions: {
            issuer: 'Shuttlez',
            audience: 'ShuttlezApp',
            expiresIn: '5m',
          },
        }),
      ],
      providers: [
        SocketIdentity,
        SupportChatGateway,
        {
          provide: PrismaService,
          useValue: {
            supportTicket: {
              findFirst: async ({
                where,
              }: {
                where: { id: string; userId: string; isDeleted: boolean };
              }) => {
                const owned: Record<string, string> = {
                  'ticket-rider': 'rider-1',
                  'ticket-captain': 'captain-1',
                };
                if (where.isDeleted) return null;
                return owned[where.id] === where.userId ? { id: where.id } : null;
              },
            },
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0);
    gateway = app.get(SupportChatGateway);
    jwt = app.get(JwtService);
  });

  afterEach(() => {
    for (const socket of open) socket.close();
    open.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  function tokenFor(userId: string): string {
    return jwt.sign({ sub: userId });
  }

  function connect(token?: string): Socket {
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const socket = io(`http://127.0.0.1:${port}`, {
      path: '/hubs/support-chat',
      transports: ['websocket'],
      auth: token ? { token } : {},
      reconnection: false,
      forceNew: true,
    });
    open.push(socket);
    return socket;
  }

  async function connected(socket: Socket): Promise<void> {
    if (socket.connected) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket connect timeout')), 4000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function roomSize(room: string): number {
    const server = gateway.server as Server;
    return server.sockets.adapter.rooms.get(room)?.size ?? 0;
  }

  async function waitForRoom(room: string, present: boolean): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const size = roomSize(room);
      if (present ? size > 0 : size === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`room ${room} present=${present} size=${roomSize(room)}`);
  }

  function nextMessage(socket: Socket, ms = 400): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        socket.off('SupportMessageCreated', onMessage);
        resolve(null);
      }, ms);
      const onMessage = (data: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(data);
      };
      socket.once('SupportMessageCreated', onMessage);
    });
  }

  it('delivers a staff reply only to the captain who owns that ticket', async () => {
    const captain = connect(tokenFor('captain-1'));
    const rider = connect(tokenFor('rider-1'));
    await connected(captain);
    await connected(rider);
    captain.emit('JoinTicket', 'ticket-captain');
    rider.emit('JoinTicket', 'ticket-rider');
    await waitForRoom('ticket-ticket-captain', true);
    await waitForRoom('ticket-ticket-rider', true);

    const captainMessage = nextMessage(captain);
    const riderMessage = nextMessage(rider);
    gateway.publish({
      id: 'msg-staff',
      ticketId: 'ticket-captain',
      isFromSupport: true,
      content: 'رد الدعم للكابتن',
      createdAt: '2026-10-27T12:00:00.000Z',
    });

    await expect(captainMessage).resolves.toMatchObject({
      id: 'msg-staff',
      ticketId: 'ticket-captain',
      isFromSupport: true,
      content: 'رد الدعم للكابتن',
      createdAt: '2026-10-27T12:00:00.000Z',
    });
    await expect(riderMessage).resolves.toBeNull();
  });

  it('does not deliver a rider ticket to another user, a bad token, or a socket send attempt', async () => {
    const stranger = connect(tokenFor('captain-1'));
    const invalid = connect('not-a-jwt');
    const anonymous = connect();
    await connected(stranger);
    await connected(invalid);
    await connected(anonymous);

    stranger.emit('JoinTicket', 'ticket-rider');
    invalid.emit('JoinTicket', 'ticket-rider');
    anonymous.emit('JoinTicket', 'ticket-rider');
    stranger.emit('SendMessage', { ticketId: 'ticket-rider', content: 'steal' });
    await waitForRoom('ticket-ticket-rider', false);

    const leaked = nextMessage(stranger);
    gateway.publish({
      id: 'msg-rider',
      ticketId: 'ticket-rider',
      isFromSupport: false,
      content: 'رسالة الراكب الخاصة',
      createdAt: '2026-10-27T12:01:00.000Z',
    });
    await expect(leaked).resolves.toBeNull();
    expect(roomSize('ticket-ticket-rider')).toBe(0);
  });

  it('does not replay a message published while the owner is offline, and a later message arrives once', async () => {
    gateway.publish({
      id: 'msg-offline',
      ticketId: 'ticket-captain',
      isFromSupport: true,
      content: 'وصل قبل الاتصال',
      createdAt: '2026-10-27T12:02:00.000Z',
    });

    const captain = connect(tokenFor('captain-1'));
    await connected(captain);
    const duringJoin = nextMessage(captain, 250);
    captain.emit('JoinTicket', 'ticket-captain');
    await waitForRoom('ticket-ticket-captain', true);
    await expect(duringJoin).resolves.toBeNull();

    captain.close();
    await waitForRoom('ticket-ticket-captain', false);
    const reconnected = connect(tokenFor('captain-1'));
    await connected(reconnected);
    reconnected.emit('JoinTicket', 'ticket-captain');
    await waitForRoom('ticket-ticket-captain', true);

    const delivered = nextMessage(reconnected);
    gateway.publish({
      id: 'msg-live',
      ticketId: 'ticket-captain',
      isFromSupport: true,
      content: 'بعد إعادة الاتصال',
      createdAt: '2026-10-27T12:03:00.000Z',
    });
    await expect(delivered).resolves.toMatchObject({ id: 'msg-live' });
  });
});
