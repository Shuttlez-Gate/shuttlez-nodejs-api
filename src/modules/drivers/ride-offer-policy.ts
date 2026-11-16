import { RideRequestStatus } from '../../common/enums';
import { ErrorCodes } from '../../common/error-codes';
import { haversineKm } from '../../common/utils/money';
import { vehicleKindFamily, type VehicleKindFamily } from '../../common/utils/enums-map';

/** Default offer radius. Captains farther than this are not eligible. */
export const OFFER_MAX_RADIUS_KM = 5;
/** Client-supplied radius cannot widen targeting past this cap. */
export const OFFER_RADIUS_CAP_KM = 10;
/** An in-progress ride may surface another offer only inside this ETA. */
export const NEAR_COMPLETION_MINUTES = 5;
export const CITY_MINUTES_PER_KM = 2.5;
/** Pending ride requests older than this are not offered. Also the presence freshness window. */
export const RIDE_REQUEST_FRESH_MS = 15 * 60 * 1000;
export const LOCATION_FRESH_MS = RIDE_REQUEST_FRESH_MS;

export type OfferBlockReason =
  | 'inactive'
  | 'offline'
  | 'active_shuttle'
  | 'active_group'
  | 'en_route_to_pickup'
  | 'ride_not_finishing'
  | 'eta_unknown'
  | 'missing_location'
  | 'stale_location'
  | 'pickup_too_far'
  | 'vehicle_mismatch';

export type OfferDecision = {
  visible: boolean;
  actionable: boolean;
  reason: OfferBlockReason | 'eligible';
  distanceKm: number | null;
};

export function resolveOfferRadiusKm(radiusKm?: number | null): number {
  if (radiusKm != null && Number.isFinite(radiusKm) && radiusKm > 0) {
    return Math.min(radiusKm, OFFER_RADIUS_CAP_KM);
  }
  return OFFER_MAX_RADIUS_KM;
}

/**
 * Marketplace vehicle families. `sedan`, `private_car`, and `group_car` are car
 * requests in the rider and captain apps, and are not separate shuttle types.
 */
export function offerVehicleFamily(raw?: string | number | null): VehicleKindFamily | null {
  const key = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (['privatecar', 'groupcar', 'sedan'].includes(key)) return 'car';
  return vehicleKindFamily(raw);
}

export function offerVehicleCompatible(
  requested?: string | null,
  captain?: string | null,
): boolean {
  const need = offerVehicleFamily(requested);
  const have = offerVehicleFamily(captain);
  if (!need || !have) return true;
  return need === have;
}

export function estimateRideRemainingMinutes(input: {
  captainLatitude?: number | null;
  captainLongitude?: number | null;
  destinationLatitude?: number | null;
  destinationLongitude?: number | null;
  startedAt?: Date | null;
  distanceKm?: number | null;
  nowMs: number;
}): number | null {
  const {
    captainLatitude,
    captainLongitude,
    destinationLatitude,
    destinationLongitude,
    startedAt,
    distanceKm,
    nowMs,
  } = input;
  if (
    captainLatitude != null &&
    captainLongitude != null &&
    destinationLatitude != null &&
    destinationLongitude != null
  ) {
    return Math.round(
      haversineKm(
        captainLatitude,
        captainLongitude,
        destinationLatitude,
        destinationLongitude,
      ) * CITY_MINUTES_PER_KM,
    );
  }
  if (startedAt != null && distanceKm != null && Number.isFinite(Number(distanceKm))) {
    const totalMins = Math.max(NEAR_COMPLETION_MINUTES, Math.round(Number(distanceKm) * CITY_MINUTES_PER_KM));
    const elapsedMins = (nowMs - startedAt.getTime()) / 60_000;
    return Math.max(0, Math.round(totalMins - elapsedMins));
  }
  return null;
}

export function workloadBlockReason(input: {
  isActive: boolean;
  isOnline: boolean;
  hasActiveShuttle: boolean;
  hasActiveGroup: boolean;
  activeRideStatus?: number | null;
  remainingMinutes?: number | null;
}): OfferBlockReason | null {
  if (!input.isActive) return 'inactive';
  if (!input.isOnline) return 'offline';
  if (input.hasActiveShuttle) return 'active_shuttle';
  if (input.hasActiveGroup) return 'active_group';
  if (input.activeRideStatus === RideRequestStatus.Assigned) return 'en_route_to_pickup';
  if (input.activeRideStatus === RideRequestStatus.InProgress) {
    if (input.remainingMinutes == null) return 'eta_unknown';
    if (input.remainingMinutes > NEAR_COMPLETION_MINUTES) return 'ride_not_finishing';
  }
  return null;
}

export function evaluateOfferEligibility(input: {
  isActive: boolean;
  isOnline: boolean;
  hasActiveShuttle: boolean;
  hasActiveGroup: boolean;
  activeRideStatus?: number | null;
  remainingMinutes?: number | null;
  captainLatitude?: number | null;
  captainLongitude?: number | null;
  activeRideDestinationLatitude?: number | null;
  activeRideDestinationLongitude?: number | null;
  pickupLatitude?: number | null;
  pickupLongitude?: number | null;
  radiusKm?: number | null;
  requestedVehicleKind?: string | null;
  captainVehicleKind?: string | null;
  locationUpdatedAtMs?: number | null;
  nowMs?: number;
  enforceLocationFreshness?: boolean;
}): OfferDecision {
  const blocked = workloadBlockReason(input);
  if (blocked) {
    return { visible: false, actionable: false, reason: blocked, distanceKm: null };
  }

  const nowMs = input.nowMs ?? Date.now();
  if (input.enforceLocationFreshness) {
    const updatedAt = input.locationUpdatedAtMs;
    if (updatedAt == null || nowMs - updatedAt > LOCATION_FRESH_MS) {
      return { visible: false, actionable: false, reason: 'stale_location', distanceKm: null };
    }
  }

  const nearCompletion =
    input.activeRideStatus === RideRequestStatus.InProgress &&
    input.remainingMinutes != null &&
    input.remainingMinutes <= NEAR_COMPLETION_MINUTES;
  const evalLat =
    nearCompletion && input.activeRideDestinationLatitude != null
      ? input.activeRideDestinationLatitude
      : input.captainLatitude;
  const evalLng =
    nearCompletion && input.activeRideDestinationLongitude != null
      ? input.activeRideDestinationLongitude
      : input.captainLongitude;
  if (evalLat == null || evalLng == null) {
    return { visible: false, actionable: false, reason: 'missing_location', distanceKm: null };
  }
  if (!offerVehicleCompatible(input.requestedVehicleKind, input.captainVehicleKind)) {
    return { visible: false, actionable: false, reason: 'vehicle_mismatch', distanceKm: null };
  }
  if (input.pickupLatitude == null || input.pickupLongitude == null) {
    return { visible: false, actionable: false, reason: 'missing_location', distanceKm: null };
  }

  const distanceKm = haversineKm(evalLat, evalLng, input.pickupLatitude, input.pickupLongitude);
  const radius = resolveOfferRadiusKm(input.radiusKm);
  if (distanceKm > radius) {
    return { visible: false, actionable: false, reason: 'pickup_too_far', distanceKm };
  }
  return { visible: true, actionable: true, reason: 'eligible', distanceKm };
}

export interface BroadcastPresence {
  userId: string;
  latitude: number;
  longitude: number;
  hasActiveRide?: boolean;
  remainingMinutes?: number | null;
  vehicleKind?: string | null;
  updatedAtMs: number;
}

/**
 * Captains who were actually sent an offer. Cancellation is emitted only to
 * that set, plus an assigned captain when the ride was already claimed.
 */
export class OfferAudience {
  private readonly byRide = new Map<string, Set<string>>();

  remember(rideId: string, userIds: Iterable<string>) {
    const id = rideId.trim();
    if (!id) return;
    const set = this.byRide.get(id) ?? new Set<string>();
    for (const userId of userIds) {
      const value = userId.trim();
      if (value) set.add(value);
    }
    if (set.size > 0) this.byRide.set(id, set);
  }

  targets(rideId: string, extraUserIds: Iterable<string> = []): string[] {
    const set = new Set(this.byRide.get(rideId.trim()) ?? []);
    for (const userId of extraUserIds) {
      const value = userId.trim();
      if (value) set.add(value);
    }
    return [...set];
  }

  forget(rideId: string) {
    this.byRide.delete(rideId.trim());
  }
}

export function selectBroadcastRecipients(input: {
  pickupLatitude?: number | null;
  pickupLongitude?: number | null;
  requestedVehicleKind?: string | null;
  presences: BroadcastPresence[];
  nowMs: number;
  radiusKm?: number | null;
}): Array<{ userId: string; distanceKm: number }> {
  if (input.pickupLatitude == null || input.pickupLongitude == null) return [];
  const recipients: Array<{ userId: string; distanceKm: number }> = [];
  for (const presence of input.presences) {
    const decision = evaluateOfferEligibility({
      isActive: true,
      isOnline: true,
      hasActiveShuttle: false,
      hasActiveGroup: false,
      activeRideStatus: presence.hasActiveRide ? RideRequestStatus.InProgress : null,
      remainingMinutes: presence.remainingMinutes,
      captainLatitude: presence.latitude,
      captainLongitude: presence.longitude,
      pickupLatitude: input.pickupLatitude,
      pickupLongitude: input.pickupLongitude,
      radiusKm: input.radiusKm ?? OFFER_MAX_RADIUS_KM,
      requestedVehicleKind: input.requestedVehicleKind,
      captainVehicleKind: presence.vehicleKind,
      locationUpdatedAtMs: presence.updatedAtMs,
      nowMs: input.nowMs,
      enforceLocationFreshness: true,
    });
    if (!decision.actionable || decision.distanceKm == null) continue;
    recipients.push({ userId: presence.userId, distanceKm: decision.distanceKm });
  }
  return recipients;
}

export type RideAcceptDecision =
  | { action: 'claim' }
  | { action: 'idempotent' }
  | { action: 'reject'; statusCode: number; code: string; message: string };

/** Only a still-open request can be claimed. Terminal states are never rewound. */
export function decideRideAccept(input: {
  status: number;
  rideDriverId: string | null;
  actorDriverId: string;
}): RideAcceptDecision {
  const sameDriver = input.rideDriverId != null && input.rideDriverId === input.actorDriverId;
  if (input.status === RideRequestStatus.Cancelled) {
    return {
      action: 'reject',
      statusCode: 400,
      code: ErrorCodes.RideNotAssignable,
      message: 'تم إلغاء هذا المشوار من قبل الراكب',
    };
  }
  if (input.status === RideRequestStatus.Completed) {
    return {
      action: 'reject',
      statusCode: 400,
      code: ErrorCodes.RideAlreadyCompleted,
      message: 'لا يمكن قبول مشوار مكتمل',
    };
  }
  if (input.status === RideRequestStatus.InProgress) {
    return {
      action: 'reject',
      statusCode: 400,
      code: ErrorCodes.RideAlreadyStarted,
      message: 'لا يمكن قبول مشوار قيد التنفيذ',
    };
  }
  if (input.status === RideRequestStatus.Assigned) {
    if (sameDriver) return { action: 'idempotent' };
    return {
      action: 'reject',
      statusCode: 400,
      code: ErrorCodes.RideNotAssignable,
      message: 'تم قبول هذا المشوار من قبل كابتن آخر',
    };
  }
  if (input.status === RideRequestStatus.Requested) {
    if (input.rideDriverId == null || sameDriver) return { action: 'claim' };
    return {
      action: 'reject',
      statusCode: 400,
      code: ErrorCodes.RideNotAssignable,
      message: 'تم قبول هذا المشوار من قبل كابتن آخر',
    };
  }
  return {
    action: 'reject',
    statusCode: 400,
    code: ErrorCodes.RideNotAssignable,
    message: 'لا يمكن قبول المشوار في هذه الحالة',
  };
}
