import { Prisma } from '@prisma/client';
import { RideRequestStatus } from '../../common/enums';
import { DriversService } from './drivers.service';

describe('DriversService cash collection', () => {
  const driver = { id: 'driver-1', userId: 'driver-user-1', isActive: true };

  function harness(options?: { status?: number; paymentMethod?: string; ownerId?: string; failCreate?: boolean }) {
    const ride = {
      id: 'ride-1',
      driverId: options?.ownerId ?? driver.id,
      riderUserId: 'rider-1',
      status: options?.status ?? RideRequestStatus.InProgress,
      paymentMethod: options?.paymentMethod ?? 'cash',
      totalAmount: new Prisma.Decimal(30),
      fareAmount: new Prisma.Decimal(25),
      isDeleted: false,
    };
    let collection: Record<string, unknown> | null = null;
    let queue = Promise.resolve();
    const tx = {
      rideRequest: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
          where.driverId === ride.driverId && !ride.isDeleted ? ride : null),
      },
      rideCashCollection: {
        findUnique: jest.fn(async () => collection),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (options?.failCreate) throw new Error('database write failed');
          if (collection) throw new Error('unique ride collection');
          collection = data;
          return data;
        }),
      },
    };
    const prisma = {
      driver: { findFirst: jest.fn(async () => driver) },
      rideRequest: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
          where.driverId === ride.driverId && !ride.isDeleted ? ride : null),
      },
      rideCashCollection: { findUnique: jest.fn(async () => collection) },
      $transaction: jest.fn(async (callback: (transaction: unknown) => Promise<unknown>) => {
        const result = queue.then(() => callback(tx));
        queue = result.then(() => undefined, () => undefined);
        return result;
      }),
    };
    const outboxEvents: unknown[] = [];
    const outbox = {
      enqueue: jest.fn(async (_transaction: unknown, event: unknown) => { outboxEvents.push(event); }),
      wake: jest.fn(),
    };
    const service = new DriversService(
      prisma as never,
      { requireUserId: () => driver.userId } as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      outbox as never,
    );
    return { service, prisma, ride, outbox, outboxEvents, getCollection: () => collection };
  }

  it('records one collection and one outbox event for concurrent requests', async () => {
    const { service, outbox, outboxEvents, getCollection } = harness();
    const results = await Promise.all([
      service.confirmRideCash('ride-1'),
      service.confirmRideCash('ride-1'),
    ]);

    expect(getCollection()).toMatchObject({ rideId: 'ride-1', driverId: driver.id, currency: 'EGP' });
    expect(Number(getCollection()?.amount)).toBe(30);
    expect(results.map((result) => result.idempotent).sort()).toEqual([false, true]);
    expect(outboxEvents).toHaveLength(1);
    expect(outbox.wake).toHaveBeenCalledTimes(1);
  });

  it('returns the original collection on a later retry without creating another event', async () => {
    const { service, outbox, getCollection } = harness();
    const first = await service.confirmRideCash('ride-1');
    const second = await service.confirmRideCash('ride-1');

    expect(second).toMatchObject({ collectionId: first.collectionId, idempotent: true, fareAmount: 30 });
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(getCollection()).not.toBeNull();
  });

  it('rolls back collection and emits nothing when the database write fails', async () => {
    const { service, outbox, getCollection } = harness({ failCreate: true });

    await expect(service.confirmRideCash('ride-1')).rejects.toThrow('database write failed');

    expect(getCollection()).toBeNull();
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(outbox.wake).not.toHaveBeenCalled();
  });

  it('rejects collection for an invalid ride status and for a non-cash payment', async () => {
    const invalidState = harness({ status: RideRequestStatus.Assigned });
    const nonCash = harness({ paymentMethod: 'card' });

    await expect(invalidState.service.confirmRideCash('ride-1')).rejects.toThrow();
    await expect(nonCash.service.confirmRideCash('ride-1')).rejects.toThrow();
    expect(invalidState.getCollection()).toBeNull();
    expect(nonCash.getCollection()).toBeNull();
  });

  it('does not disclose or collect a ride assigned to another driver', async () => {
    const { service, outbox, getCollection } = harness({ ownerId: 'other-driver' });

    await expect(service.confirmRideCash('ride-1')).rejects.toThrow();

    expect(getCollection()).toBeNull();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
