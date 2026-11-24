import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { CurrentUserService } from '../../common/current-user.service';
import {
  AppException,
  NotFoundException,
} from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import { RideRequestStatus } from '../../common/enums';
import { baseFields } from '../../common/utils/entity-defaults';
import { newId, utcNow } from '../../common/utils/date.util';
import { money, refCode, requireCash, splitEarnings } from '../../common/utils/money';
import { rideStatusLabel } from '../../common/utils/enums-map';
import { FareService } from '../pricing/fare.service';
import { PlacesService } from '../places/places.service';
import { publishRiderHistoryChange } from '../realtime/rider-history-signal';
import { DriverGateway, RideTrackingGateway } from '../realtime/realtime.gateway';
import { RideOutboxService } from '../realtime/ride-outbox.service';

@Injectable()
export class RidesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
    private readonly fare: FareService,
    private readonly driverGateway?: DriverGateway,
    private readonly rideTrackingGateway?: RideTrackingGateway,
    @Optional() private readonly places?: PlacesService,
    @Optional() private readonly rideOutbox?: RideOutboxService,
  ) {}

  async quote(query: {
    fromZoneKey?: string;
    toZoneKey?: string;
    pickupLatitude?: number;
    pickupLongitude?: number;
    destinationLatitude?: number;
    destinationLongitude?: number;
  }) {
    this.currentUser.requireUserId();
    const rule = await this.fare.resolveRideRule(query.fromZoneKey, query.toZoneKey);
    const distanceKm = await this.tripDistanceKm(
      query.pickupLatitude,
      query.pickupLongitude,
      query.destinationLatitude,
      query.destinationLongitude,
    );
    const fareAmount = this.fare.rideFare(rule, distanceKm);
    const platformPercent = await this.fare.platformCommissionPercent();
    const split = splitEarnings(fareAmount, platformPercent);
    const perKm = money(rule.pricePerKm) > 0;
    return {
      rideFareRuleId: rule.id,
      ruleName: rule.name,
      fromZoneKey: rule.fromZoneKey,
      toZoneKey: rule.toZoneKey,
      fareAmount,
      platformCommissionPercent: platformPercent,
      commissionAmount: split.commissionAmount,
      captainEarnings: split.captainEarnings,
      totalAmount: fareAmount,
      paymentMethodHint: 'cash',
      distanceKm,
      baseFare: perKm ? money(rule.baseFare) : null,
      pricePerKm: perKm ? money(rule.pricePerKm) : null,
      minimumFare: perKm && rule.minimumFare != null ? money(rule.minimumFare) : null,
    };
  }

  async fareOptions() {
    this.currentUser.requireUserId();
    const asOf = new Date();
    const rules = await this.prisma.rideFareRule.findMany({
      where: {
        isDeleted: false,
        isActive: true,
        OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: asOf } }],
      },
      orderBy: { createdAt: 'desc' },
    });
    return rules
      .filter(
        (r) =>
          (r.effectiveTo == null || r.effectiveTo >= asOf) &&
          (money(r.flatFare) > 0 || money(r.pricePerKm) > 0),
      )
      .map((r) => ({
        id: r.id,
        name: r.name,
        fromZoneKey: r.fromZoneKey,
        toZoneKey: r.toZoneKey,
        flatFare: money(r.flatFare),
        baseFare: money(r.baseFare),
        pricePerKm: money(r.pricePerKm),
        minimumFare: r.minimumFare == null ? null : money(r.minimumFare),
      }));
  }

  async create(body: {
    pickupLatitude: number;
    pickupLongitude: number;
    destinationLatitude: number;
    destinationLongitude: number;
    pickupAddress?: string;
    destinationAddress?: string;
    fromZoneKey?: string;
    toZoneKey?: string;
    paymentMethod?: string;
    scheduledFor?: string;
    requestedVehicleKind?: string;
  }) {
    const userId = this.currentUser.requireUserId();
    const paymentMethod = requireCash(body.paymentMethod);
    const rule = await this.fare.resolveRideRule(body.fromZoneKey, body.toZoneKey);
    const platformPercent = await this.fare.platformCommissionPercent();
    const distanceKm = await this.tripDistanceKm(
      body.pickupLatitude,
      body.pickupLongitude,
      body.destinationLatitude,
      body.destinationLongitude,
    );
    const fareAmount = this.fare.rideFare(rule, distanceKm);
    const split = splitEarnings(fareAmount, platformPercent);
    const perKm = money(rule.pricePerKm) > 0;
    const scheduledFor = parseScheduledFor(body.scheduledFor);
    await this.closeAbandonedSearches(userId);
    const ride = await this.prisma.rideRequest.create({
      include: rideInclude,
      data: {
        id: newId(),
        riderUserId: userId,
        pickupLatitude: body.pickupLatitude,
        pickupLongitude: body.pickupLongitude,
        pickupAddress: trimOrNull(body.pickupAddress),
        destinationLatitude: body.destinationLatitude,
        destinationLongitude: body.destinationLongitude,
        destinationAddress: trimOrNull(body.destinationAddress),
        fromZoneKey: trimOrNull(body.fromZoneKey),
        toZoneKey: trimOrNull(body.toZoneKey),
        rideFareRuleId: rule.id,
        status: RideRequestStatus.Requested,
        fareAmount,
        commissionRate: split.commissionRate,
        commissionAmount: split.commissionAmount,
        captainEarnings: split.captainEarnings,
        totalAmount: fareAmount,
        paymentMethod,
        isCashConfirmed: true,
        referenceCode: refCode('RD'),
        distanceKm: distanceKm == null ? null : new Prisma.Decimal(distanceKm),
        baseFareApplied: perKm ? rule.baseFare : null,
        pricePerKmApplied: perKm ? rule.pricePerKm : null,
        minimumFareApplied: perKm ? rule.minimumFare : null,
        scheduledFor,
        ...baseFields(),
      },
    });
        const requestedVehicleKind = trimVehicleKind(body.requestedVehicleKind);
    if (requestedVehicleKind) {
      await this.prisma.$executeRaw`
        UPDATE "RideRequestsSet"
        SET "RequestedVehicleKind" = ${requestedVehicleKind}
        WHERE "Id" = ${ride.id}::uuid
      `;
    }

    try {
      const rider = await this.prisma.user.findFirst({
        where: { id: userId },
        select: {
          fullName: true,
          phone: true,
          ratingAverage: true,
          ratingCount: true,
          avatarUrl: true,
        },
      });
      const tripKm = distanceKm ?? 2.5;
      this.driverGateway?.broadcastNewRide({
        id: ride.id,
        vehicleKind: requestedVehicleKind || 'car',
        passengerName: rider?.fullName || 'راكب شاتلز',
        passengerPhone: rider?.phone ?? null,
        passengerRating: rider ? Number(rider.ratingAverage) : 4.9,
        passengerRatingCount: rider?.ratingCount ?? 0,
        passengerAvatarUrl: rider?.avatarUrl ?? null,
        referenceCode: ride.referenceCode,
        pickupAddress: ride.pickupAddress || 'نقطة الانطلاق',
        dropoffAddress: ride.destinationAddress || 'الوجهة المحددة',
        pickupLatitude: ride.pickupLatitude,
        pickupLongitude: ride.pickupLongitude,
        destinationLatitude: ride.destinationLatitude,
        destinationLongitude: ride.destinationLongitude,
        fare: money(ride.fareAmount),
        earnings: money(ride.captainEarnings),
        distanceKm: distanceKm == null ? 2.5 : money(distanceKm),
        tripDistanceKm: money(tripKm),
        durationMinutes: Math.max(1, Math.round((tripKm / 30) * 60)),
        etaMinutes: Math.max(3, Math.round(tripKm * 2.5)),
        createdAt: ride.createdAt,
        paymentMethod: ride.paymentMethod || 'cash',
        timeoutSeconds: 30,
      });
    } catch {
      // Intentionally swallowing unknown error
    }

    return this.mapRide(ride, requestedVehicleKind);
  }

  /// A rider has one live search. An older Requested ride must not stay on
  /// the home badge after they book again or finish a newer trip.
  async closeAbandonedSearches(riderUserId: string, exceptRideId?: string) {
    const now = utcNow();
    const open = await this.prisma.rideRequest.findMany({
      where: {
        riderUserId,
        isDeleted: false,
        status: RideRequestStatus.Requested,
        ...(exceptRideId ? { id: { not: exceptRideId } } : {}),
        OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
      },
      select: { id: true },
    });
    if (open.length === 0) return;

    const ids = open.map((ride) => ride.id);
    await this.prisma.rideRequest.updateMany({
      where: {
        id: { in: ids },
        status: RideRequestStatus.Requested,
        isDeleted: false,
      },
      data: {
        status: RideRequestStatus.Cancelled,
        cancelledAt: now,
        updatedAt: now,
      },
    });

    for (const id of ids) {
      this.driverGateway?.broadcastRideWithdrawn(id);
      this.rideTrackingGateway?.publishRideCancelled(id, 'rider');
      publishRiderHistoryChange({
        userId: riderUserId,
        product: 'ride',
        id,
      });
    }
  }

  async mine() {
    const userId = this.currentUser.requireUserId();
    const items = await this.prisma.rideRequest.findMany({
      where: { riderUserId: userId, isDeleted: false },
      include: rideInclude,
      orderBy: { createdAt: 'desc' },
    });
    const kinds = await this.requestedVehicleKinds(items.map((item) => item.id));
    return items.map((r) => this.mapRide(r, kinds.get(r.id) ?? null));
  }

  async byId(id: string) {
    const userId = this.currentUser.requireUserId();
    const ride = await this.prisma.rideRequest.findFirst({
      where: { id, isDeleted: false },
      include: rideInclude,
    });
    if (!ride) {
      throw new NotFoundException('المشوار غير موجود', ErrorCodes.RideNotFound);
    }
    if (ride.riderUserId !== userId && !this.currentUser.isAdmin) {
      throw new AppException('غير مصرح', 403);
    }
    const kinds = await this.requestedVehicleKinds([ride.id]);
    return this.mapRide(ride, kinds.get(ride.id) ?? null);
  }

  async cancel(id: string) {
    const userId = this.currentUser.requireUserId();
    const ride = await this.prisma.rideRequest.findFirst({
      where: { id, riderUserId: userId, isDeleted: false },
      include: rideInclude,
    });
    if (!ride) {
      throw new NotFoundException('المشوار غير موجود', ErrorCodes.RideNotFound);
    }
    if (ride.status === RideRequestStatus.Cancelled) {
      const kinds = await this.requestedVehicleKinds([ride.id]);
      return this.mapRide(ride, kinds.get(ride.id) ?? null);
    }
    if (
      ride.status === RideRequestStatus.Completed ||
      ride.status === RideRequestStatus.InProgress
    ) {
      throw new AppException(
        ride.status === RideRequestStatus.InProgress
          ? 'لا يمكن إلغاء مشوار قيد التنفيذ'
          : 'لا يمكن إلغاء هذا المشوار',
        400,
        ErrorCodes.RideNotCancellable,
      );
    }
    const cancelledAt = utcNow();
    const cancelled = await this.prisma.$transaction(async (tx) => {
      const result = await tx.rideRequest.updateMany({
        where: {
          id: ride.id,
          riderUserId: userId,
          isDeleted: false,
          status: ride.status,
        },
        data: {
          status: RideRequestStatus.Cancelled,
          cancelledAt,
          updatedAt: cancelledAt,
        },
      });
      if (result.count === 1 && this.rideOutbox) {
        await this.rideOutbox.enqueue(tx, {
          eventType: 'ride.cancelled',
          aggregateId: ride.id,
          payload: {
            cancelledBy: 'rider',
            cancelledAt: cancelledAt.toISOString(),
            reason: null,
            assignedDriverUserId: ride.driver?.userId,
          },
        });
      }
      return result;
    });
    const updated = await this.prisma.rideRequest.findFirst({
      where: { id: ride.id, isDeleted: false },
      include: rideInclude,
    });
    if (!updated) {
      throw new NotFoundException('المشوار غير موجود', ErrorCodes.RideNotFound);
    }
    if (cancelled.count !== 1) {
      if (updated.status === RideRequestStatus.Cancelled) {
        const kinds = await this.requestedVehicleKinds([updated.id]);
        return this.mapRide(updated, kinds.get(updated.id) ?? null);
      }
      throw new AppException(
        'لا يمكن إلغاء هذا المشوار',
        400,
        ErrorCodes.RideNotCancellable,
      );
    }
    publishRiderHistoryChange({
      userId: updated.riderUserId,
      product: 'ride',
      id: updated.id,
    });
    const assignedUserId = updated.driver?.userId;
    if (this.rideOutbox) this.rideOutbox.wake();
    else {
      this.driverGateway?.broadcastRideWithdrawn(
        updated.id,
        assignedUserId ? [assignedUserId] : [],
      );
      this.rideTrackingGateway?.publishRideCancelled(updated.id, 'rider');
    }
    const kinds = await this.requestedVehicleKinds([updated.id]);
    return this.mapRide(updated, kinds.get(updated.id) ?? null);
  }

  mapRide(ride: RideRow, requestedVehicleKind: string | null = null) {
    const driver = ride.driver;
    const user = driver?.user;
    const vehicle = driver?.vehicle;
    const ratingCount = driver?.ratingCount ?? 0;
    return {
      id: ride.id,
      riderUserId: ride.riderUserId,
      pickupLatitude: ride.pickupLatitude,
      pickupLongitude: ride.pickupLongitude,
      pickupAddress: ride.pickupAddress,
      destinationLatitude: ride.destinationLatitude,
      destinationLongitude: ride.destinationLongitude,
      destinationAddress: ride.destinationAddress,
      fromZoneKey: ride.fromZoneKey,
      toZoneKey: ride.toZoneKey,
      rideFareRuleId: ride.rideFareRuleId,
      status: rideStatusLabel(ride.status),
      fareAmount: money(ride.fareAmount),
      commissionRate: money(ride.commissionRate),
      commissionAmount: money(ride.commissionAmount),
      captainEarnings: money(ride.captainEarnings),
      totalAmount: money(ride.totalAmount),
      paymentMethod: ride.paymentMethod,
      isCashConfirmed: ride.isCashConfirmed,
      driverId: ride.driverId,
      driverArrivedAt: ride.driverArrivedAt,
      driverName: user?.fullName ?? null,
      assignedAt: ride.assignedAt,
      startedAt: ride.startedAt,
      completedAt: ride.completedAt,
      cancelledAt: ride.cancelledAt,
      scheduledFor: ride.scheduledFor,
      requestedVehicleKind,
      referenceCode: ride.referenceCode,
      createdAt: ride.createdAt,
      driverPhotoUrl: user?.avatarUrl ?? null,
      driverRatingAverage: ratingCount > 0 ? money(driver!.ratingAverage) : null,
      driverRatingCount: ratingCount > 0 ? ratingCount : null,
      vehicleKind: driver?.vehicleKind ?? (vehicle ? String(vehicle.type) : null),
      vehicleModel: driver?.vehicleModelName ?? vehicle?.model ?? null,
      vehicleColor: driver?.vehicleColor ?? null,
      plateNumber: driver?.plateNumber ?? vehicle?.plateNumber ?? null,
      driverPhone: user?.phone ?? null,
      distanceKm: ride.distanceKm == null ? null : money(ride.distanceKm),
      baseFareApplied:
        ride.baseFareApplied == null ? null : money(ride.baseFareApplied),
      pricePerKmApplied:
        ride.pricePerKmApplied == null ? null : money(ride.pricePerKmApplied),
      captainLatitude: null,
      captainLongitude: null,
      captainLocationUpdatedAt: null,
    };
  }

  async handleEarlyTermination(
    rideId: string,
    action: 'request' | 'accept' | 'reject',
    reason?: string,
    latitude?: number,
    longitude?: number,
  ) {
    const userId = this.currentUser.requireUserId();
    const ride = await this.prisma.rideRequest.findFirst({
      where: { id: rideId, riderUserId: userId, isDeleted: false },
    });
    if (!ride) throw new NotFoundException('المشوار غير موجود');
    if (ride.status !== RideRequestStatus.InProgress) {
      throw new AppException('لا يمكن طلب إنهاء مبكر إلا لمشوار قيد التنفيذ', 400);
    }
    if (action === 'request') {
      this.rideTrackingGateway?.publishTerminationRequested(
        rideId,
        'rider',
        reason || 'ظرف طارئ من الراكب',
        latitude,
        longitude,
      );
      return { rideId, requested: true, message: 'تم إرسال طلب الإنهاء المبكر' };
    }
    if (action === 'accept') {
      const completedAt = utcNow();
      const completed = await this.prisma.$transaction(async (tx) => {
        const result = await tx.rideRequest.updateMany({
          where: {
            id: ride.id,
            riderUserId: userId,
            isDeleted: false,
            status: RideRequestStatus.InProgress,
          },
          data: { status: RideRequestStatus.Completed, completedAt, updatedAt: completedAt },
        });
        if (result.count === 1 && this.rideOutbox) {
          await this.rideOutbox.enqueue(tx, {
            eventType: 'ride.early_completed',
            aggregateId: ride.id,
            payload: {
              completedAt: completedAt.toISOString(),
              fareAmount: Number(ride.totalAmount ?? ride.fareAmount),
              distanceKm: ride.distanceKm == null ? null : Number(ride.distanceKm),
              riderUserId: ride.riderUserId,
            },
          });
        }
        return result;
      });
      if (completed.count !== 1) {
        throw new AppException('O�U,O�O OU,U.O\'U^OO� U.U+ U�O�U,O-O� U�O�', 400, ErrorCodes.RideNotCompletable);
      }
      const updated = await this.prisma.rideRequest.findFirstOrThrow({ where: { id: ride.id } });
      if (this.rideOutbox) this.rideOutbox.wake();
      else {
        this.rideTrackingGateway?.publishTerminationResolved(rideId, true);
        this.rideTrackingGateway?.publishRideCompleted(
          updated.id,
          updated.completedAt,
          Number(updated.fareAmount),
          updated.distanceKm ? Number(updated.distanceKm) : undefined,
          updated.riderUserId,
        );
      }
      return { rideId, resolved: true, completed: true, message: 'تم قبول الإنهاء المبكر واكتمال المشوار' };
    }
    this.rideTrackingGateway?.publishTerminationResolved(rideId, false);
    return { rideId, resolved: true, completed: false, message: 'تم رفض طلب الإنهاء المبكر' };
  }

  /**
   * Instant rides are billed on the driving route the rider sees.
   * Straight-line distance underprices a road that bends.
   */
  private async tripDistanceKm(
    pickupLatitude?: number,
    pickupLongitude?: number,
    destinationLatitude?: number,
    destinationLongitude?: number,
  ): Promise<number | null> {
    const straightKm = this.fare.distanceKm(
      pickupLatitude,
      pickupLongitude,
      destinationLatitude,
      destinationLongitude,
    );
    if (
      straightKm == null ||
      pickupLatitude == null ||
      pickupLongitude == null ||
      destinationLatitude == null ||
      destinationLongitude == null ||
      this.places == null
    ) {
      return straightKm;
    }
    try {
      const route = await this.places.drivingRoute({
        originLat: pickupLatitude,
        originLng: pickupLongitude,
        destLat: destinationLatitude,
        destLng: destinationLongitude,
      });
      const roadKm = route.distanceMeters / 1000;
      if (Number.isFinite(roadKm) && roadKm > 0) {
        return roadKm;
      }
    } catch {
      // Routing can be down. Keep the straight-line distance so quoting still works.
    }
    return straightKm;
  }

  private async requestedVehicleKinds(ids: string[]) {
    const unique = [...new Set(ids.filter((id) => id.trim().length > 0))];
    const kinds = new Map<string, string | null>();
    if (unique.length === 0) return kinds;
    const rows = await this.prisma.$queryRaw<Array<{ id: string; kind: string | null }>>`
      SELECT "Id"::text AS id, "RequestedVehicleKind" AS kind
      FROM "RideRequestsSet"
      WHERE "Id"::text IN (${Prisma.join(unique)})
    `;
    for (const row of rows) {
      kinds.set(row.id, row.kind);
    }
    return kinds;
  }
}

const rideInclude = {
  driver: { include: { user: true, vehicle: true } },
} satisfies Prisma.RideRequestInclude;

type RideRow = Prisma.RideRequestGetPayload<{ include: typeof rideInclude }>;

function trimOrNull(value?: string | null): string | null {
  const v = value?.trim();
  return v ? v : null;
}

function trimVehicleKind(value?: string | null): string | null {
  const v = value?.trim();
  if (!v) return null;
  return v.slice(0, 40);
}

function parseScheduledFor(value?: string | null): Date | null {
  const raw = value?.trim();
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;

}
