import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { io, Socket } from 'socket.io-client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { DriverGateway } from './realtime.gateway';
import { SocketIdentity } from './socket-identity';

const secret = 'driver-gateway-test-secret-32chars';

describe('Driver offer Socket.IO', () => {
  let app: INestApplication;
  let gateway: DriverGateway;
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
        DriverGateway,
        {
          provide: PrismaService,
          useValue: {
            driver: {
              findFirst: async () => ({ vehicleKind: 'car', vehicle: { type: 1 } }),
            },
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0);
    gateway = app.get(DriverGateway);
    jwt = app.get(JwtService);
  });

  afterEach(() => {
    for (const socket of open) socket.close();
    open.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  function connect(userId?: string): Socket {
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const socket = io(`http://127.0.0.1:${port}`, {
      path: '/hubs/driver',
      transports: ['websocket'],
      auth: userId ? { token: jwt.sign({ sub: userId }) } : {},
      reconnection: false,
      forceNew: true,
    });
    open.push(socket);
    return socket;
  }

  function once<T>(socket: Socket, event: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), 4000);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  async function connected(socket: Socket): Promise<void> {
    if (socket.connected) return;
    await once(socket, 'connect');
  }

  async function joined(socket: Socket, userId: string, latitude: number, longitude: number) {
    await connected(socket);
    socket.emit('JoinDriverRoom', { latitude, longitude });
    const started = Date.now();
    while (Date.now() - started < 4000) {
      const presence = gateway.getDriverPresence(userId);
      if (presence && presence.latitude === latitude) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`presence missing for ${userId}`);
  }

  it('withdraws an offer from the captain who received it and not from anyone else', async () => {
    const near = connect('captain-near');
    const far = connect('captain-far');
    const stranger = connect();
    await joined(near, 'captain-near', 30.05, 31.24);
    await joined(far, 'captain-far', 10, 10);
    await connected(stranger);

    const offered = once<{ id: string }>(near, 'NewRideRequest');
    let leaked = false;
    far.on('NewRideRequest', () => {
      leaked = true;
    });
    stranger.on('NewRideRequest', () => {
      leaked = true;
    });
    gateway.broadcastNewRide({
      id: 'ride-cancel-1',
      pickupLatitude: 30.05,
      pickupLongitude: 31.24,
      vehicleKind: 'car',
      fare: 48,
    });
    await expect(offered).resolves.toMatchObject({ id: 'ride-cancel-1' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(leaked).toBe(false);

    stranger.on('RideRequestCancelled', () => {
      leaked = true;
    });
    far.on('RideRequestCancelled', () => {
      leaked = true;
    });
    const withdrawn = once<{ rideId: string; status: string }>(near, 'RideRequestCancelled');
    gateway.broadcastRideWithdrawn('ride-cancel-1');
    await expect(withdrawn).resolves.toMatchObject({
      rideId: 'ride-cancel-1',
      status: 'Cancelled',
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(leaked).toBe(false);

    gateway.broadcastRideWithdrawn('ride-cancel-1');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(leaked).toBe(false);
  });
});
