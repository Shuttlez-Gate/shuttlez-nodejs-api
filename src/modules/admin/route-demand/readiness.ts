import { VehicleType } from '../../../common/enums';
import { money, normalizeMoney, splitEarnings } from '../../../common/utils/money';

export const ReasonCodes = {
  MissingRouteLink: 'MISSING_ROUTE_LINK',
  NoPricing: 'NO_PRICING',
  MissingConfiguration: 'MISSING_CONFIGURATION',
  MissingCapacity: 'MISSING_CAPACITY',
  MissingVehicle: 'MISSING_VEHICLE',
  InvalidLaunchConfig: 'INVALID_LAUNCH_CONFIG',
  BelowMinimum: 'BELOW_MINIMUM',
  BetweenMinAndTarget: 'BETWEEN_MIN_AND_TARGET',
  MeetsTarget: 'MEETS_TARGET',
  AmbiguousRouteMatch: 'AMBIGUOUS_ROUTE_MATCH',
  DemandExceedsCapacity: 'DEMAND_EXCEEDS_CAPACITY',
  ZeroDemand: 'ZERO_DEMAND',
} as const;

export type DemandLaunchStatus =
  | 'Ready'
  | 'AlmostReady'
  | 'NotReady'
  | 'NoPricing'
  | 'MissingConfiguration'
  | 'Unknown';

export interface ReadinessInput {
  demandCount: number;
  confirmedPassengers: number;
  uniquePassengers: number;
  routeId: string | null;
  routeMatchSafe: boolean;
  vehicleType: number | null;
  capacity: number | null;
  pricingRuleId: string | null;
  pricingSource: string | null;
  oneWayPrice: number | null;
  roundTripPrice: number | null;
  weeklyPrice: number | null;
  monthlyPrice: number | null;
  minimumLaunchRiders: number | null;
  targetOccupancy: number | null;
  commissionPercent: number | null;
  commissionType: string | null;
  launchPeriodDays: number | null;
  launchStartAt: Date | null;
  launchEndAt: Date | null;
  launchActive: boolean | null;
  ambiguousRouteMatch?: boolean;
}

export interface ReadinessResult {
  launchStatus: DemandLaunchStatus;
  reasonCode: string;
  readinessReason: string;
  pricingAvailable: boolean;
  pricingLinked: boolean;
  routeId: string | null;
  vehicleType: number | null;
  capacity: number | null;
  demandCount: number;
  confirmedPassengers: number;
  uniquePassengers: number;
  occupancyPercent: number | null;
  ridersRequired: number | null;
  remainingToTarget: number | null;
  minimumLaunchRiders: number | null;
  targetOccupancy: number | null;
  pricingRuleId: string | null;
  pricingSource: string | null;
  oneWayPrice: number | null;
  roundTripPrice: number | null;
  weeklyPrice: number | null;
  monthlyPrice: number | null;
  commissionPercent: number | null;
  commissionType: string | null;
  launchPeriodDays: number | null;
  launchStartAt: Date | null;
  launchEndAt: Date | null;
  launchActive: boolean | null;
  financialAtMinimumOneWayGross: number | null;
  financialAtMinimumRoundTripGross: number | null;
  financialAtMinimumPlatformCommission: number | null;
  financialAtMinimumCaptainEarnings: number | null;
  routeLinkSource: string | null;
}

export function toApiStatus(status: DemandLaunchStatus): string {
  switch (status) {
    case 'Ready':
      return 'READY';
    case 'AlmostReady':
      return 'ALMOST_READY';
    case 'NotReady':
      return 'NOT_READY';
    case 'NoPricing':
      return 'NO_PRICING';
    case 'MissingConfiguration':
      return 'MISSING_CONFIGURATION';
    default:
      return 'UNKNOWN';
  }
}

export function occupancyFromConfirmed(confirmed: number, capacity?: number | null): number | null {
  if (capacity == null || capacity <= 0) return null;
  return Math.round((Math.max(0, confirmed) * 1000) / capacity) / 10;
}

export function tryParseVehicleType(raw?: string | null): number | null {
  if (!raw?.trim()) return null;
  const key = raw.trim().toLowerCase().replace(/[\s_-]/g, '');
  if (['1', 'car', 'shuttlecar', 'shuttlezcar', 'carshuttle', 'shuttlez'].includes(key)) {
    return VehicleType.CarShuttle;
  }
  if (['2', 'microbus', 'minibus', 'minibuss'].includes(key)) {
    return VehicleType.MiniBus;
  }
  if (['3', 'bus'].includes(key)) {
    return VehicleType.Bus;
  }
  return null;
}

export function evaluateReadiness(input: ReadinessInput): ReadinessResult {
  const confirmed = Math.max(0, input.confirmedPassengers);

  if (input.ambiguousRouteMatch) {
    return terminal(
      input,
      'Unknown',
      ReasonCodes.AmbiguousRouteMatch,
      'تطابق مسار غامض — أكثر من Route يطابق نفس المفتاح. لا يتم اختيار واحد تلقائياً.',
      false,
      false,
    );
  }

  if (!input.routeMatchSafe || !input.routeId) {
    return terminal(
      input,
      'Unknown',
      ReasonCodes.MissingRouteLink,
      'Route Demand غير مرتبط بـ RouteId رسمي. لا يتم تخمين الربط.',
      false,
      false,
    );
  }

  if (input.vehicleType == null) {
    return terminal(
      input,
      'Unknown',
      ReasonCodes.MissingVehicle,
      'نوع المركبة غير متاح بشكل موثوق.',
      false,
      true,
    );
  }

  if (input.capacity == null || input.capacity <= 0) {
    return terminal(
      input,
      'Unknown',
      ReasonCodes.MissingCapacity,
      'سعة المركبة غير متاحة أو غير صالحة.',
      input.pricingRuleId != null,
      true,
    );
  }

  if (input.pricingRuleId == null || input.oneWayPrice == null || input.roundTripPrice == null) {
    return terminal(
      input,
      'NoPricing',
      ReasonCodes.NoPricing,
      'لا توجد Pricing Rule فعالة لهذا الخط ونوع المركبة.',
      false,
      true,
    );
  }

  if (input.minimumLaunchRiders == null || input.targetOccupancy == null) {
    return terminal(
      input,
      'MissingConfiguration',
      ReasonCodes.MissingConfiguration,
      'بيانات الإطلاق ناقصة (الحد الأدنى أو هدف الإشغال).',
      true,
      true,
    );
  }

  const min = input.minimumLaunchRiders;
  const target = input.targetOccupancy;
  const capacity = input.capacity;

  if (min < 1 || target < min || target > capacity) {
    return terminal(
      input,
      'MissingConfiguration',
      ReasonCodes.InvalidLaunchConfig,
      'إعداد الإطلاق غير صالح (حد أدنى / هدف / سعة).',
      true,
      true,
    );
  }

  const occupancy = occupancyFromConfirmed(confirmed, capacity);
  const ridersRequired = Math.max(min - confirmed, 0);
  const remainingToTarget = Math.max(target - confirmed, 0);

  let launchStatus: DemandLaunchStatus;
  let reasonCode: string;
  let reason: string;
  if (confirmed < min) {
    launchStatus = 'NotReady';
    reasonCode = ReasonCodes.BelowMinimum;
    reason = `غير جاهز — متبقي ${ridersRequired} راكب مؤكّد للوصول إلى الحد الأدنى للإطلاق (${min}).`;
  } else if (confirmed < target) {
    launchStatus = 'AlmostReady';
    reasonCode = ReasonCodes.BetweenMinAndTarget;
    reason = `قريب من الإطلاق — بلغ الحد الأدنى (${min}) ولم يصل لهدف الإشغال (${target}). متبقي ${remainingToTarget}.`;
  } else {
    launchStatus = 'Ready';
    reasonCode = ReasonCodes.MeetsTarget;
    reason = `جاهز للإطلاق — الركاب المؤكدون (${confirmed}) بلغوا هدف الإشغال (${target}).`;
  }

  const preview = previewAtRiderCount(
    min,
    input.oneWayPrice,
    input.roundTripPrice,
    input.commissionPercent ?? 0,
  );

  return {
    launchStatus,
    reasonCode,
    readinessReason: reason,
    pricingAvailable: true,
    pricingLinked: true,
    routeId: input.routeId,
    vehicleType: input.vehicleType,
    capacity,
    demandCount: input.demandCount,
    confirmedPassengers: confirmed,
    uniquePassengers: input.uniquePassengers,
    occupancyPercent: occupancy,
    ridersRequired,
    remainingToTarget,
    minimumLaunchRiders: min,
    targetOccupancy: target,
    pricingRuleId: input.pricingRuleId,
    pricingSource: input.pricingSource,
    oneWayPrice: normalizeMoney(input.oneWayPrice),
    roundTripPrice: normalizeMoney(input.roundTripPrice),
    weeklyPrice: input.weeklyPrice != null ? normalizeMoney(input.weeklyPrice) : null,
    monthlyPrice: input.monthlyPrice != null ? normalizeMoney(input.monthlyPrice) : null,
    commissionPercent: input.commissionPercent,
    commissionType: input.commissionType,
    launchPeriodDays: input.launchPeriodDays,
    launchStartAt: input.launchStartAt,
    launchEndAt: input.launchEndAt,
    launchActive: input.launchActive,
    financialAtMinimumOneWayGross: preview.oneWayGross,
    financialAtMinimumRoundTripGross: preview.roundTripGross,
    financialAtMinimumPlatformCommission: preview.platform,
    financialAtMinimumCaptainEarnings: preview.captain,
    routeLinkSource: null,
  };
}

function previewAtRiderCount(
  riders: number,
  oneWay: number,
  roundTrip: number,
  commissionPercent: number,
) {
  const oneWayGross = normalizeMoney(oneWay * riders);
  const roundTripGross = normalizeMoney(roundTrip * riders);
  const split = splitEarnings(roundTripGross, commissionPercent);
  return {
    oneWayGross,
    roundTripGross,
    platform: split.commissionAmount,
    captain: split.captainEarnings,
  };
}

function terminal(
  input: ReadinessInput,
  status: DemandLaunchStatus,
  reasonCode: string,
  reason: string,
  pricingAvailable: boolean,
  pricingLinked: boolean,
): ReadinessResult {
  const confirmed = Math.max(0, input.confirmedPassengers);
  return {
    launchStatus: status,
    reasonCode,
    readinessReason: reason,
    pricingAvailable,
    pricingLinked,
    routeId: input.routeId,
    vehicleType: input.vehicleType,
    capacity: input.capacity != null && input.capacity > 0 ? input.capacity : null,
    demandCount: input.demandCount,
    confirmedPassengers: confirmed,
    uniquePassengers: input.uniquePassengers,
    occupancyPercent: occupancyFromConfirmed(confirmed, input.capacity),
    ridersRequired:
      input.minimumLaunchRiders != null
        ? Math.max(input.minimumLaunchRiders - confirmed, 0)
        : null,
    remainingToTarget:
      input.targetOccupancy != null ? Math.max(input.targetOccupancy - confirmed, 0) : null,
    minimumLaunchRiders: input.minimumLaunchRiders,
    targetOccupancy: input.targetOccupancy,
    pricingRuleId: pricingAvailable ? input.pricingRuleId : null,
    pricingSource: pricingAvailable ? input.pricingSource : null,
    oneWayPrice: pricingAvailable ? input.oneWayPrice : null,
    roundTripPrice: pricingAvailable ? input.roundTripPrice : null,
    weeklyPrice: pricingAvailable ? input.weeklyPrice : null,
    monthlyPrice: pricingAvailable ? input.monthlyPrice : null,
    commissionPercent: pricingAvailable ? input.commissionPercent : null,
    commissionType: pricingAvailable ? input.commissionType : null,
    launchPeriodDays: pricingAvailable ? input.launchPeriodDays : null,
    launchStartAt: pricingAvailable ? input.launchStartAt : null,
    launchEndAt: pricingAvailable ? input.launchEndAt : null,
    launchActive: pricingAvailable ? input.launchActive : null,
    financialAtMinimumOneWayGross: null,
    financialAtMinimumRoundTripGross: null,
    financialAtMinimumPlatformCommission: null,
    financialAtMinimumCaptainEarnings: null,
    routeLinkSource: null,
  };
}

export function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = money(value as never);
  return Number.isFinite(n) ? n : null;
}
