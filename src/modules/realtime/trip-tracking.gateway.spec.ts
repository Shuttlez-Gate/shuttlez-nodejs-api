import { BookingStatus, TripStatus } from '../../common/enums';
import type { PrismaService } from '../../database/prisma/prisma.service';
import { TripTrackingGateway } from './realtime.gateway';
import type { SocketIdentity } from './socket-identity';

describe('TripTrackingGateway JoinTrip authorization', () => {
  function harness(input: {
    userId: string | null;
    trip: Record<string, unknown> | null;
  }) {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue(
        input.trip
          ? [{
              status: input.trip.status,
              startedAt: input.trip.startedAt,
              driverUserId: (input.trip.driver as { userId: string }).userId,
              riderUserId: (input.trip.bookings as Array<{ userId: string }>)[0]?.userId ?? null,
            }]
          : [],
      ),
      rideRequest: { findFirst: jest.fn() },
      groupRequest: { findFirst: jest.fn() },
    };
    const identity = { userId: jest.fn().mockResolvedValue(input.userId) };
    const gateway = new TripTrackingGateway(
      identity as unknown as SocketIdentity,
      prisma as unknown as PrismaService,
    );
    const client = {
      join: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn(),
    };
    return { gateway, prisma, client };
  }

  it('authorizes a booked rider and gets start state in the same trip read', async () => {
    const startedAt = new Date('2026-11-24T12:00:00.000Z');
    const { gateway, prisma, client } = harness({
      userId: 'rider-1',
      trip: {
        status: TripStatus.InProgress,
        startedAt,
        driver: { userId: 'driver-1' },
        bookings: [{ userId: 'rider-1', status: BookingStatus.Confirmed }],
      },
    });

    await gateway.join(client as never, 'trip-1');

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(client.join).toHaveBeenCalledWith(['trip-trip-1', 'user-rider-1']);
    expect(client.emit).toHaveBeenCalledWith(
      'TripStarted',
      expect.objectContaining({
        tripId: 'trip-1',
        startedAt: startedAt.toISOString(),
      }),
    );
    expect(prisma.rideRequest.findFirst).not.toHaveBeenCalled();
    expect(prisma.groupRequest.findFirst).not.toHaveBeenCalled();
  });

  it('does not join rooms for an unrelated authenticated user', async () => {
    const { gateway, prisma, client } = harness({
      userId: 'unrelated-user',
      trip: {
        status: TripStatus.Scheduled,
        startedAt: null,
        driver: { userId: 'driver-1' },
        bookings: [{ userId: 'rider-1', status: BookingStatus.Confirmed }],
      },
    });

    await gateway.join(client as never, 'trip-1');

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).not.toHaveBeenCalled();
  });

  it('does not join rooms without a verified socket identity', async () => {
    const { gateway, prisma, client } = harness({ userId: null, trip: null });

    await gateway.join(client as never, 'trip-1');

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
  });
});
