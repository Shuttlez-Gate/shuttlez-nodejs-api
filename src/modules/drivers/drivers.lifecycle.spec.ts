import { RideRequestStatus } from '../../common/enums';
import { DriversService } from './drivers.service';

describe('DriversService ride lifecycle', () => {
  const driver = { id: 'driver-1', userId: 'user-driver-1', isActive: true };
  const riderUserId = 'user-rider-1';

  function harness(initialStatus: number) {
    const ride: Record<string, unknown> = {
      id: 'ride-1',
      driverId: initialStatus === RideRequestStatus.Requested ? null : driver.id,
      riderUserId,
      isDeleted: false,
      status: initialStatus,
      driverArrivedAt: null,
      startedAt: null,
      completedAt: null,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      totalAmount: 20,
      fareAmount: 20,
      distanceKm: 2,
    };
    const transactionContext: { client?: unknown } = {};
    const snapshot = () => ({ ...ride });
    const rideGateway = {
      publishRideStarted: jest.fn(),
      publishRideCompleted: jest.fn(),
      publishRideCancelled: jest.fn(),
      publishArrivalConfirmed: jest.fn(),
    };
    const driverGateway = { releaseActiveRide: jest.fn() };
    const prisma = {
      driver: { findFirst: jest.fn(async () => driver) },
      $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(transactionContext.client)),
      rideRequest: {
        findFirst: jest.fn(async () => snapshot()),
        findFirstOrThrow: jest.fn(async () => snapshot()),
        updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const matches = Object.entries(where).every(([key, value]) => ride[key] === value);
          if (!matches) return { count: 0 };
          Object.assign(ride, data);
          return { count: 1 };
        }),
      },
      rideOfferDecision: {
        findUnique: jest.fn(async () => null),
        createMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    transactionContext.client = prisma;
    const service = new DriversService(
      prisma as never,
      { requireUserId: () => driver.userId } as never,
      { closeAbandonedSearches: jest.fn(async () => undefined) } as never,
      {} as never,
      undefined,
      driverGateway as never,
      rideGateway as never,
    );
    return { service, ride, prisma, rideGateway, driverGateway };
  }

  it('starts concurrently requested rides once and returns idempotent success to the loser', async () => {
    const { service, ride, rideGateway } = harness(RideRequestStatus.Assigned);
    const results = await Promise.all([service.startRide('ride-1'), service.startRide('ride-1')]);

    expect(ride.status).toBe(RideRequestStatus.InProgress);
    expect(results.filter((result) => result.idempotent)).toHaveLength(1);
    expect(rideGateway.publishRideStarted).toHaveBeenCalledTimes(1);
  });

  it('completes concurrently requested rides once and does not emit duplicate completion events', async () => {
    const { service, ride, rideGateway } = harness(RideRequestStatus.InProgress);
    const results = await Promise.all([service.completeRide('ride-1'), service.completeRide('ride-1')]);

    expect(ride.status).toBe(RideRequestStatus.Completed);
    expect(results.filter((result) => result.idempotent)).toHaveLength(1);
    expect(rideGateway.publishRideCompleted).toHaveBeenCalledTimes(1);
  });

  it('persists arrival once and treats a concurrent duplicate arrival as idempotent', async () => {
    const { service, ride, rideGateway, prisma } = harness(RideRequestStatus.Assigned);
    const results = await Promise.all([service.arriveRide('ride-1'), service.arriveRide('ride-1')]);

    expect(ride.driverArrivedAt).toBeInstanceOf(Date);
    expect(results.filter((result) => result.idempotent)).toHaveLength(1);
    expect(prisma.rideRequest.updateMany).toHaveBeenCalledTimes(2);
    expect(rideGateway.publishArrivalConfirmed).toHaveBeenCalledTimes(1);
  });

  it('refuses completion before start without changing state or emitting completion', async () => {
    const { service, ride, prisma, rideGateway } = harness(RideRequestStatus.Assigned);

    await expect(service.completeRide('ride-1')).rejects.toThrow();

    expect(ride.status).toBe(RideRequestStatus.Assigned);
    expect(prisma.rideRequest.updateMany).not.toHaveBeenCalled();
    expect(rideGateway.publishRideCompleted).not.toHaveBeenCalled();
  });

  it('has one winner when completion races driver cancellation', async () => {
    const { service, ride } = harness(RideRequestStatus.InProgress);

    await Promise.all([
      service.completeRide('ride-1').catch(() => undefined),
      service.cancelRideByDriver('ride-1').catch(() => undefined),
    ]);

    expect([RideRequestStatus.Completed, RideRequestStatus.Cancelled]).toContain(ride.status);
    expect(ride.completedAt !== null).toBe(ride.status === RideRequestStatus.Completed);
  });

  it('does not emit lifecycle events when the conditional database write fails', async () => {
    const { service, rideGateway, prisma } = harness(RideRequestStatus.Assigned);
    prisma.rideRequest.updateMany.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(service.startRide('ride-1')).rejects.toThrow('database unavailable');

    expect(rideGateway.publishRideStarted).not.toHaveBeenCalled();
  });

  it('keeps offer rejection idempotent and prevents it from overwriting a concurrent completion', async () => {
    const { service, ride } = harness(RideRequestStatus.InProgress);
    const results = await Promise.all([
      service.completeRide('ride-1'),
      service.rejectRide('ride-1').catch((error: unknown) => error),
    ]);

    expect(results[1]).toBeInstanceOf(Error);
    expect(ride.status).toBe(RideRequestStatus.Completed);
  });

  it('allows repeated rejection of an open offer without mutating the shared ride', async () => {
    const { service, ride, prisma } = harness(RideRequestStatus.Requested);
    const results = await Promise.all([service.rejectRide('ride-1'), service.rejectRide('ride-1')]);

    expect(results.every((result) => result.rejected)).toBe(true);
    expect(ride.status).toBe(RideRequestStatus.Requested);
    expect(prisma.rideRequest.updateMany).toHaveBeenCalledTimes(2);
    for (const [update] of prisma.rideRequest.updateMany.mock.calls) {
      expect(update.data).toHaveProperty('updatedAt');
      expect(update.data).not.toHaveProperty('status');
    }
  });

  it('returns not found for a missing ride without emitting events', async () => {
    const { service, rideGateway, prisma } = harness(RideRequestStatus.Assigned);
    prisma.rideRequest.findFirst.mockResolvedValueOnce(null as never);

    await expect(service.startRide('missing')).rejects.toThrow();

    expect(rideGateway.publishRideStarted).not.toHaveBeenCalled();
  });
});
