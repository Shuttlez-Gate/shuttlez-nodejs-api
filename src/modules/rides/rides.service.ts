import { Injectable } from '@nestjs/common';
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

@Injectable()
export class RidesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
    private readonly fare: FareService,
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
    const distanceKm = this.fare.distanceKm(
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
  }) {
    const userId = this.currentUser.requireUserId();
    const paymentMethod = requireCash(body.paymentMethod);
    const rule = await this.fare.resolveRideRule(body.fromZoneKey, body.toZoneKey);
    const platformPercent = await this.fare.platformCommissionPercent();
    const distanceKm = this.fare.distanceKm(
      body.pickupLatitude,
      body.pickupLongitude,
      body.destinationLatitude,
      body.destinationLongitude,
    );
    const fareAmount = this.fare.rideFare(rule, distanceKm);
    const split = splitEarnings(fareAmount, platformPercent);
    const perKm = money(rule.pricePerKm) > 0;
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
        ...baseFields(),
      },
    });
    return this.mapRide(ride);
  }

  async mine() {
    const userId = this.currentUser.requireUserId();
    const items = await this.prisma.rideRequest.findMany({
      where: { riderUserId: userId, isDeleted: false },
      include: rideInclude,
      orderBy: { createdAt: 'desc' },
    });
    return items.map((r) => this.mapRide(r));
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
    return this.mapRide(ride);
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
    if (
      ride.status === RideRequestStatus.Completed ||
      ride.status === RideRequestStatus.Cancelled
    ) {
      throw new AppException(
        'لا يمكن إلغاء هذا المشوار',
        400,
        ErrorCodes.RideNotCancellable,
      );
    }
    if (ride.status === RideRequestStatus.InProgress) {
      throw new AppException(
        'لا يمكن إلغاء مشوار قيد التنفيذ',
        400,
        ErrorCodes.RideNotCancellable,
      );
    }
    const updated = await this.prisma.rideRequest.update({
      where: { id: ride.id },
      data: {
        status: RideRequestStatus.Cancelled,
        cancelledAt: utcNow(),
        updatedAt: utcNow(),
      },
      include: rideInclude,
    });
    return this.mapRide(updated);
  }

  mapRide(ride: RideRow) {
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
      driverName: user?.fullName ?? null,
      assignedAt: ride.assignedAt,
      startedAt: ride.startedAt,
      completedAt: ride.completedAt,
      cancelledAt: ride.cancelledAt,
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
}

const rideInclude = {
  driver: { include: { user: true, vehicle: true } },
} satisfies Prisma.RideRequestInclude;

type RideRow = Prisma.RideRequestGetPayload<{ include: typeof rideInclude }>;

function trimOrNull(value?: string | null): string | null {
  const v = value?.trim();
  return v ? v : null;
}
