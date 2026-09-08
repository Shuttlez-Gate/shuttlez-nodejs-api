import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';
import { AppException } from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import {
  distanceFare,
  haversineKm,
  money,
  normalizeMoney,
} from '../../common/utils/money';
import { VehicleType } from '../../common/enums';

@Injectable()
export class FareService {
  constructor(private readonly prisma: PrismaService) {}

  async platformCommissionPercent(
    routeId?: string | null,
    vehicleType?: number | null,
    asOf = new Date(),
  ): Promise<number> {
    if (routeId) {
      const pricing = await this.prisma.pricingRule.findFirst({
        where: {
          isDeleted: false,
          isActive: true,
          routeId,
          ...(vehicleType != null ? { vehicleType } : {}),
          OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: asOf } }],
        },
        orderBy: { createdAt: 'desc' },
      });
      if (pricing) {
        const launchEnd = pricing.launchStartAt
          ? new Date(
              pricing.launchStartAt.getTime() +
                pricing.launchPeriodDays * 86400000,
            )
          : null;
        const inLaunch =
          pricing.launchStartAt != null &&
          launchEnd != null &&
          asOf >= pricing.launchStartAt &&
          asOf <= launchEnd;
        return money(
          inLaunch
            ? pricing.launchCommissionPercent
            : pricing.permanentCommissionPercent,
        );
      }
    }

    const rule = await this.prisma.commissionRule.findFirst({
      where: {
        isDeleted: false,
        isActive: true,
        OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: asOf } }],
      },
      orderBy: { createdAt: 'desc' },
    });
    return rule ? money(rule.platformCommissionPercent) : 0;
  }

  async resolveRideRule(fromZoneKey?: string | null, toZoneKey?: string | null) {
    const asOf = new Date();
    const from = normalizeZone(fromZoneKey);
    const to = normalizeZone(toZoneKey);
    const active = await this.prisma.rideFareRule.findMany({
      where: {
        isDeleted: false,
        isActive: true,
        OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: asOf } }],
      },
      orderBy: { createdAt: 'desc' },
    });
    const usable = active.filter(
      (r) =>
        (r.effectiveTo == null || r.effectiveTo >= asOf) &&
        (money(r.flatFare) > 0 || money(r.pricePerKm) > 0),
    );

    if (from && to) {
      const exact = usable.find(
        (r) =>
          normalizeZone(r.fromZoneKey) === from &&
          normalizeZone(r.toZoneKey) === to,
      );
      if (exact) {
        return exact;
      }
      const reverse = usable.find(
        (r) =>
          normalizeZone(r.fromZoneKey) === to &&
          normalizeZone(r.toZoneKey) === from,
      );
      if (reverse) {
        return reverse;
      }
    }

    const flat = usable.find(
      (r) => !normalizeZone(r.fromZoneKey) && !normalizeZone(r.toZoneKey),
    );
    if (flat) {
      return flat;
    }
    throw new AppException(
      'لا توجد قاعدة تسعير نشطة للمشوار. يرجى ضبط كتالوج أجرة العربية من لوحة التحكم.',
      400,
      ErrorCodes.RideFareNotConfigured,
    );
  }

  async resolveGroupRule(fromZoneKey?: string | null, toZoneKey?: string | null) {
    const asOf = new Date();
    const from = normalizeZone(fromZoneKey);
    const to = normalizeZone(toZoneKey);
    const active = await this.prisma.groupFareRule.findMany({
      where: {
        isDeleted: false,
        isActive: true,
        OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: asOf } }],
      },
      orderBy: { createdAt: 'desc' },
    });
    const usable = active.filter(
      (r) =>
        (r.effectiveTo == null || r.effectiveTo >= asOf) &&
        r.maxMembers >= 1 &&
        (money(r.charterFlatFare) > 0 || money(r.pricePerKm) > 0),
    );

    if (from && to) {
      const exact = usable.find(
        (r) =>
          normalizeZone(r.fromZoneKey) === from &&
          normalizeZone(r.toZoneKey) === to,
      );
      if (exact) {
        return exact;
      }
      const reverse = usable.find(
        (r) =>
          normalizeZone(r.fromZoneKey) === to &&
          normalizeZone(r.toZoneKey) === from,
      );
      if (reverse) {
        return reverse;
      }
    }

    const flat = usable.find(
      (r) => !normalizeZone(r.fromZoneKey) && !normalizeZone(r.toZoneKey),
    );
    if (flat) {
      return flat;
    }
    throw new AppException(
      'لا توجد قاعدة تسعير نشطة للمجموعة. يرجى ضبط كتالوج أجرة المجموعة من لوحة التحكم.',
      400,
      ErrorCodes.GroupFareNotConfigured,
    );
  }

  rideFare(
    rule: {
      flatFare: { toNumber(): number } | number;
      baseFare: { toNumber(): number } | number;
      pricePerKm: { toNumber(): number } | number;
      minimumFare: { toNumber(): number } | number | null;
      maximumFare: { toNumber(): number } | number | null;
    },
    distanceKm?: number | null,
  ): number {
    const perKm = money(rule.pricePerKm);
    if (perKm > 0) {
      if (distanceKm == null) {
        throw new AppException(
          'إحداثيات الانطلاق والوجهة مطلوبة لتسعير المشوار حسب المسافة.',
          400,
          ErrorCodes.TripCoordinatesRequired,
        );
      }
      return distanceFare(
        money(rule.baseFare),
        distanceKm,
        perKm,
        rule.minimumFare == null ? null : money(rule.minimumFare),
        rule.maximumFare == null ? null : money(rule.maximumFare),
      );
    }
    return normalizeMoney(money(rule.flatFare));
  }

  groupFare(
    rule: {
      charterFlatFare: { toNumber(): number } | number;
      baseFare: { toNumber(): number } | number;
      pricePerKm: { toNumber(): number } | number;
      minimumFare: { toNumber(): number } | number | null;
      maximumFare: { toNumber(): number } | number | null;
    },
    distanceKm?: number | null,
  ): number {
    const perKm = money(rule.pricePerKm);
    if (perKm > 0) {
      if (distanceKm == null) {
        throw new AppException(
          'إحداثيات الانطلاق والوجهة مطلوبة لتسعير المجموعة حسب المسافة.',
          400,
          ErrorCodes.TripCoordinatesRequired,
        );
      }
      return distanceFare(
        money(rule.baseFare),
        distanceKm,
        perKm,
        rule.minimumFare == null ? null : money(rule.minimumFare),
        rule.maximumFare == null ? null : money(rule.maximumFare),
      );
    }
    return normalizeMoney(money(rule.charterFlatFare));
  }

  distanceKm(
    pickupLat?: number | null,
    pickupLng?: number | null,
    destLat?: number | null,
    destLng?: number | null,
  ): number | null {
    if (
      pickupLat == null ||
      pickupLng == null ||
      destLat == null ||
      destLng == null
    ) {
      return null;
    }
    return haversineKm(pickupLat, pickupLng, destLat, destLng);
  }

  resolvePricingRule(
    rules: Array<{
      routeId: string | null;
      vehicleType: number;
      oneWayPrice: { toNumber(): number } | number;
      isActive: boolean;
    }>,
    routeId?: string | null,
    vehicleType = VehicleType.CarShuttle,
  ) {
    return (
      rules.find((r) => r.routeId === routeId && r.vehicleType === vehicleType) ??
      rules.find((r) => r.routeId == null && r.vehicleType === vehicleType) ??
      rules[0]
    );
  }
}

function normalizeZone(key?: string | null): string | null {
  const v = key?.trim().toLowerCase();
  return v ? v : null;
}
