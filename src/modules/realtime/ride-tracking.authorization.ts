import { Injectable } from '@nestjs/common';
import { RideRequestStatus } from '../../common/enums';
import { PrismaService } from '../../database/prisma/prisma.service';
import { newId } from '../../common/utils/date.util';

export type RideParticipantRole = 'rider' | 'driver';

export type AuthorizedRide = {
  id: string;
  riderUserId: string;
  driverId: string | null;
  status: number;
  driverArrivedAt: Date | null;
  pickupLatitude: number;
  pickupLongitude: number;
  fareAmount: unknown;
  totalAmount: unknown;
  distanceKm: unknown;
  rider: { isDeleted: boolean; isActive: boolean };
  driver: { userId: string; isDeleted: boolean; user: { isDeleted: boolean; isActive: boolean } } | null;
};

export const RIDE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RideTrackingAuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  async authorize(
    rideId: string,
    userId: string,
    roles: RideParticipantRole[],
    statuses?: number[],
  ): Promise<{ ride: AuthorizedRide; role: RideParticipantRole } | null> {
    if (!userId || !RIDE_ID_PATTERN.test(rideId)) return null;
    const ride = await this.prisma.rideRequest.findFirst({
      where: { id: rideId, isDeleted: false },
      select: {
        id: true,
        riderUserId: true,
        driverId: true,
        status: true,
        driverArrivedAt: true,
        pickupLatitude: true,
        pickupLongitude: true,
        fareAmount: true,
        totalAmount: true,
        distanceKm: true,
        rider: { select: { isDeleted: true, isActive: true } },
        driver: { select: { userId: true, isDeleted: true, user: { select: { isDeleted: true, isActive: true } } } },
      },
    }) as AuthorizedRide | null;
    if (!ride || (statuses && !statuses.includes(ride.status))) return null;

    const sameUser = (left: string | null | undefined, right: string) =>
      Boolean(left) && left!.toLowerCase() === right.toLowerCase();
    const role: RideParticipantRole | null =
      !ride.rider.isDeleted && ride.rider.isActive && sameUser(ride.riderUserId, userId)
        ? 'rider'
        : ride.driver && !ride.driver.isDeleted && !ride.driver.user.isDeleted &&
            ride.driver.user.isActive && sameUser(ride.driver.userId, userId)
          ? 'driver'
          : null;
    if (!role || !roles.includes(role)) return null;
    return { ride, role };
  }

  /** The status predicate makes completion a compare-and-set transition. */
  async completeEarly(
    ride: AuthorizedRide,
    completedAt: Date,
  ): Promise<{ completed: false } | { completed: true; eventId: string }> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.rideRequest.updateMany({
        where: {
          id: ride.id,
          riderUserId: ride.riderUserId,
          driverId: ride.driverId,
          status: RideRequestStatus.InProgress,
          isDeleted: false,
        },
        data: {
          status: RideRequestStatus.Completed,
          completedAt,
          updatedAt: completedAt,
        },
      });
      if (result.count !== 1) return { completed: false };
      const eventId = newId();
      await tx.outboxEvent.create({
        data: {
          id: eventId,
          eventType: 'ride.early_completed',
          aggregateId: ride.id,
          payload: {
            completedAt: completedAt.toISOString(),
            fareAmount: Number(ride.totalAmount ?? ride.fareAmount),
            distanceKm: ride.distanceKm == null ? null : Number(ride.distanceKm),
            riderUserId: ride.riderUserId,
          },
        },
      });
      return { completed: true, eventId };
    });
  }
}
