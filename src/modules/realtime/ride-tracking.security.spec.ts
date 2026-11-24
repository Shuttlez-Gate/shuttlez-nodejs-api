import { RideRequestStatus } from '../../common/enums';
import { PrismaService } from '../../database/prisma/prisma.service';
import { SocketIdentity } from './socket-identity';
import { RideTrackingGateway } from './realtime.gateway';
import { RideTrackingAuthorizationService } from './ride-tracking.authorization';
import { Server, Socket } from 'socket.io';

const rideId = '00000000-0000-4000-8000-000000000001';
const riderId = '00000000-0000-4000-8000-000000000002';
const driverId = '00000000-0000-4000-8000-000000000003';
const driverUserId = '00000000-0000-4000-8000-000000000004';
const previousDriverUserId = '00000000-0000-4000-8000-000000000005';
const unrelatedId = '00000000-0000-4000-8000-000000000006';

type FakeClient = Socket & {
  data: { userId: string | null };
  joined: string[];
  events: Array<{ event: string; payload: unknown }>;
};

describe('Ride tracking socket authorization', () => {
  let gateway: RideTrackingGateway;
  let ride: Record<string, unknown>;
  let emitted: Array<{ room: string; event: string; payload: unknown }>;
  let identity: { userId: jest.Mock };

  // Keep Socket mock methods bound to the object created for each test caller.
  const makeClient = (userId: string | null): FakeClient => {
    const value = {
      data: { userId },
      joined: [] as string[],
      events: [] as Array<{ event: string; payload: unknown }>,
    };
    const socket = {
      ...value,
      join: jest.fn(async (room: string) => { socket.joined.push(room); }),
      leave: jest.fn(async () => undefined),
      emit: jest.fn((event: string, payload: unknown) => { socket.events.push({ event, payload }); }),
    } as unknown as FakeClient;
    return socket;
  };

  beforeEach(() => {
    emitted = [];
    ride = {
      id: rideId,
      riderUserId: riderId,
      driverId,
      isDeleted: false,
      driverArrivedAt: null,
      status: RideRequestStatus.InProgress,
      pickupLatitude: 30,
      pickupLongitude: 31,
      fareAmount: 100,
      totalAmount: 100,
      distanceKm: 5,
      driver: {
        userId: driverUserId,
        isDeleted: false,
        user: { isDeleted: false, isActive: true, fullName: 'Captain', phone: '01000000000', avatarUrl: null },
        ratingAverage: 4.8,
        ratingCount: 10,
        vehicleKind: 'car',
        vehicleModelName: 'Sedan',
        vehicleColor: 'blue',
        plateNumber: 'ABC',
        vehicle: null,
      },
      rider: { isDeleted: false, isActive: true },
      pickupAddress: 'Pickup',
      destinationLatitude: 30.1,
      destinationLongitude: 31.1,
      destinationAddress: 'Destination',
      fromZoneKey: null,
      toZoneKey: null,
      startedAt: new Date(),
      assignedAt: new Date(),
      completedAt: null,
      cancelledAt: null,
    };
    identity = {
      userId: jest.fn(async (socket: FakeClient) => socket.data.userId),
    };
    const transactionContext: { client?: unknown } = {};
    const prisma = {
      $transaction: jest.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback(transactionContext.client)),
      rideRequest: {
        findFirst: jest.fn(async () => ride.isDeleted ? null : ride),
        updateMany: jest.fn(async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const matches = Object.entries(where).every(([key, value]) => ride[key] === value);
          if (ride.isDeleted || !matches) {
            return { count: 0 };
          }
          Object.assign(ride, data);
          return { count: 1 };
        }),
      },
      outboxEvent: {
        create: jest.fn(async () => undefined),
        update: jest.fn(async () => undefined),
      },
    };
    transactionContext.client = prisma;
    const prismaService = prisma as unknown as PrismaService;
    gateway = new RideTrackingGateway(
      identity as unknown as SocketIdentity,
      prismaService,
      new RideTrackingAuthorizationService(prismaService),
    );
    gateway.server = {
      to: (initialRoom: string) => {
        const rooms = [initialRoom];
        const broadcaster = {
          to: (room: string) => { rooms.push(room); return broadcaster; },
          emit: (event: string, payload: unknown) => {
            emitted.push({ room: rooms.join(','), event, payload });
          },
        };
        return broadcaster;
      },
    } as unknown as Server;
  });

  it('rejects unauthenticated clients before joining or receiving state', async () => {
    const socket = makeClient(null);
    const result = await gateway.joinRide(socket, { rideId });
    expect(result).toMatchObject({ success: false, reason: 'UNAUTHORIZED' });
    expect(socket.joined).toEqual([]);
    expect(socket.events.some((event) => event.event === 'RideStateSync')).toBe(false);
  });

  it('does not let an unrelated authenticated user join or receive RideStateSync', async () => {
    const socket = makeClient(unrelatedId);
    const result = await gateway.joinRide(socket, { rideId });
    expect(result).toMatchObject({ success: false, reason: 'UNAUTHORIZED' });
    expect(socket.joined).toEqual([]);
    expect(socket.events).toEqual([]);
  });

  it('rejects unauthenticated access to every protected ride event', async () => {
    const anonymous = makeClient(null);
    expect(await gateway.broadcastLocation(anonymous, { rideId, latitude: 30, longitude: 31 })).toMatchObject({ success: false });
    expect(await gateway.confirmArrival(anonymous, { rideId })).toMatchObject({ success: false });
    expect(await gateway.requestTermination(anonymous, { rideId, initiator: 'rider' })).toMatchObject({ success: false });
    expect(await gateway.resolveTermination(anonymous, { rideId, accept: true })).toMatchObject({ success: false });
    expect(anonymous.joined).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('allows the rider and currently assigned driver to join and sync state', async () => {
    for (const userId of [riderId, driverUserId]) {
      const socket = makeClient(userId);
      const result = await gateway.joinRide(socket, { rideId });
      expect(result).toMatchObject({ success: true, rideId });
      expect(socket.joined).toContain(`ride-${rideId}`);
      expect(socket.events.some((event) => event.event === 'RideStateSync')).toBe(true);
    }
  });

  it('authorizes the driver by driver.userId, not by the Driver row id', async () => {
    const socket = makeClient(driverId);
    const result = await gateway.joinRide(socket, { rideId });
    expect(result).toMatchObject({ success: false, reason: 'UNAUTHORIZED' });
    expect(socket.joined).toEqual([]);
  });

  it('blocks unrelated users from broadcasting location and validates coordinates', async () => {
    const stranger = makeClient(unrelatedId);
    expect(await gateway.broadcastLocation(stranger, { rideId, latitude: 30, longitude: 31 })).toMatchObject({ success: false });
    const driver = makeClient(driverUserId);
    expect(await gateway.broadcastLocation(driver, { rideId, latitude: 91, longitude: 31 })).toMatchObject({ success: false, reason: 'INVALID_REQUEST' });
    expect(emitted).toEqual([]);
  });

  it('allows only the assigned driver to publish valid location', async () => {
    expect(await gateway.broadcastLocation(makeClient(riderId), { rideId, latitude: 30, longitude: 31 })).toMatchObject({ success: false });
    const driver = makeClient(driverUserId);
    expect(await gateway.broadcastLocation(driver, { rideId, latitude: 30, longitude: 31 })).toMatchObject({ success: true });
    expect(emitted.some((event) => event.event === 'CaptainLocationUpdated')).toBe(true);
    expect(gateway.getLastLocation(rideId)).toBeDefined();
  });

  it('blocks unrelated users from confirming arrival and permits the assigned driver while assigned', async () => {
    const stranger = makeClient(unrelatedId);
    expect(await gateway.confirmArrival(stranger, { rideId })).toMatchObject({ success: false });
    ride.status = RideRequestStatus.Assigned;
    expect(await gateway.confirmArrival(makeClient(riderId), { rideId })).toMatchObject({ success: false });
    const driver = makeClient(driverUserId);
    expect(await gateway.confirmArrival(driver, { rideId })).toMatchObject({ success: true });
    expect(await gateway.confirmArrival(driver, { rideId })).toMatchObject({ success: true, idempotent: true });
    expect(gateway.isArrived(rideId)).toBe(true);
    expect(emitted.filter((event) => event.event === 'CaptainArrivalConfirmed')).toHaveLength(1);
  });

  it('blocks unrelated termination requests and derives the initiator from the verified user', async () => {
    const stranger = makeClient(unrelatedId);
    expect(await gateway.requestTermination(stranger, { rideId, initiator: 'rider' })).toMatchObject({ success: false });
    const rider = makeClient(riderId);
    expect(await gateway.requestTermination(rider, { rideId, initiator: 'driver', reason: 'help' })).toMatchObject({ success: true });
    expect(gateway.getPendingTermination(rideId)?.initiator).toBe('rider');
  });

  it('emits a fare-collected event only once within this gateway process', () => {
    gateway.publishFareCollected(rideId, 100, riderId);
    gateway.publishFareCollected(rideId, 100, riderId);

    expect(emitted.filter((event) => event.event === 'FareCollected')).toHaveLength(1);
  });

  it('allows only the other ride participant to resolve a pending termination', async () => {
    await gateway.requestTermination(makeClient(riderId), { rideId, initiator: 'rider' });
    expect(await gateway.resolveTermination(makeClient(unrelatedId), { rideId, accept: true })).toMatchObject({ success: false });
    expect(await gateway.resolveTermination(makeClient(riderId), { rideId, accept: true })).toMatchObject({ success: false });
    expect(ride.status).toBe(RideRequestStatus.InProgress);
    expect(await gateway.resolveTermination(makeClient(driverUserId), { rideId, accept: true })).toMatchObject({ success: true, accepted: true });
    expect(ride.status).toBe(RideRequestStatus.Completed);
    expect(emitted.some((event) => event.event === 'RideCompleted')).toBe(true);
  });

  it('rejects a previously assigned driver after reassignment', async () => {
    const oldDriver = makeClient(driverUserId);
    (ride.driver as { userId: string }).userId = previousDriverUserId;
    expect(await gateway.joinRide(oldDriver, { rideId })).toMatchObject({ success: false });
    expect(await gateway.broadcastLocation(oldDriver, { rideId, latitude: 30, longitude: 31 })).toMatchObject({ success: false });
    expect(oldDriver.joined).toEqual([]);
  });

  it('rejects invalid statuses and deleted rides', async () => {
    const driver = makeClient(driverUserId);
    ride.status = RideRequestStatus.Completed;
    expect(await gateway.confirmArrival(driver, { rideId })).toMatchObject({ success: false });
    ride.isDeleted = true;
    expect(await gateway.joinRide(makeClient(riderId), { rideId })).toMatchObject({ success: false });
  });

  it('serializes competing termination resolutions so only one transition succeeds', async () => {
    await gateway.requestTermination(makeClient(riderId), { rideId, initiator: 'rider' });
    const resolver = makeClient(driverUserId);
    const results = await Promise.all([
      gateway.resolveTermination(resolver, { rideId, accept: true }),
      gateway.resolveTermination(resolver, { rideId, accept: true }),
    ]);
    expect(results.filter((result) => (result as { success?: boolean }).success)).toHaveLength(1);
    expect(ride.status).toBe(RideRequestStatus.Completed);
    expect(emitted.filter((event) => event.event === 'RideCompleted')).toHaveLength(1);
  });

  it('rejects malformed ride IDs without querying or exposing ride state', async () => {
    const socket = makeClient(riderId);
    const result = await gateway.joinRide(socket, { rideId: 'not-a-uuid' });
    expect(result).toMatchObject({ success: false, reason: 'INVALID_REQUEST' });
    expect(socket.events).toEqual([]);
  });

  it('does not treat a malformed termination resolution as a rejection', async () => {
    await gateway.requestTermination(makeClient(riderId), { rideId, initiator: 'rider' });
    expect(await gateway.resolveTermination(makeClient(driverUserId), { rideId, accept: 'false' })).toMatchObject({
      success: false,
      reason: 'INVALID_REQUEST',
    });
    expect(gateway.getPendingTermination(rideId)).toBeDefined();
    expect(ride.status).toBe(RideRequestStatus.InProgress);
  });
});
