import { RideOutboxService } from './ride-outbox.service';

describe('RideOutboxService', () => {
  function setup(events: unknown[] = []) {
    const tx = { $queryRaw: jest.fn(async () => events) };
    const prisma = {
      $transaction: jest.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx)),
      outboxEvent: { create: jest.fn(), update: jest.fn(async () => undefined) },
      rideRequest: { findFirst: jest.fn(async () => null) },
    };
    const driverGateway = {
      server: {},
      notifyClaimed: jest.fn(),
      broadcastNewRide: jest.fn(),
      broadcastRideWithdrawn: jest.fn(),
    };
    const rideTracking = {
      server: {},
      publishRideAccepted: jest.fn(),
      publishRideStarted: jest.fn(),
      publishRideCompleted: jest.fn(),
      publishTerminationResolved: jest.fn(),
      publishRideCancelled: jest.fn(),
      publishArrivalConfirmed: jest.fn(),
      publishFareCollected: jest.fn(),
    };
    const tripTracking = { server: {}, publishTripStarted: jest.fn() };
    const service = new RideOutboxService(
      prisma as never,
      driverGateway as never,
      rideTracking as never,
      tripTracking as never,
    );
    return { service, tx, prisma, driverGateway, rideTracking, tripTracking };
  }

  it('inserts an event through the caller transaction', async () => {
    const { service } = setup();
    const transaction = { outboxEvent: { create: jest.fn(async () => undefined) } };

    await service.enqueue(transaction as never, {
      eventType: 'ride.cash_collected',
      aggregateId: 'ride-id',
      payload: { amount: 12, currency: 'EGP' },
    });

    expect(transaction.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'ride.cash_collected', aggregateId: 'ride-id' }),
    }));
  });

  it('dispatches a claimed event and records its stable ID as delivered', async () => {
    const event = {
      Id: 'event-id',
      EventType: 'ride.started',
      AggregateId: 'ride-id',
      Payload: { startedAt: '2026-01-01T00:00:00.000Z', riderUserId: 'rider-id' },
      AttemptCount: 1,
    };
    const { service, prisma, rideTracking, tripTracking } = setup([event]);

    await service.processPending();

    expect(rideTracking.publishRideStarted).toHaveBeenCalledWith(
      'ride-id',
      new Date('2026-01-01T00:00:00.000Z'),
      'rider-id',
      'event-id',
    );
    expect(tripTracking.publishTripStarted).toHaveBeenCalledWith('ride-id', ['rider-id'], 'event-id');
    expect(prisma.outboxEvent.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'event-id' },
      data: expect.objectContaining({ status: 'delivered', deliveredAt: expect.any(Date) }),
    }));
  });

  it('returns undeliverable events to pending with a retry time and error', async () => {
    const event = {
      Id: 'event-id',
      EventType: 'ride.cash_collected',
      AggregateId: 'ride-id',
      Payload: { amount: 25, riderUserId: 'rider-id' },
      AttemptCount: 2,
    };
    const { service, prisma, rideTracking } = setup([event]);
    rideTracking.server = undefined;

    await service.processPending();

    expect(rideTracking.publishFareCollected).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'event-id' },
      data: expect.objectContaining({
        status: 'pending',
        nextAttemptAt: expect.any(Date),
        processingStartedAt: null,
        lastError: 'Ride socket gateway is not ready',
      }),
    }));
  });
});
