import { normalizePlaceName, placesCompatible } from '../marketplace/route-match';

export const PurchaseStatus = {
  PendingPayment: 'PENDING_PAYMENT',
  PaymentSubmitted: 'PAYMENT_SUBMITTED',
  PendingVerification: 'PENDING_VERIFICATION',
  Paid: 'PAID',
  Rejected: 'REJECTED',
  Expired: 'EXPIRED',
  Cancelled: 'CANCELLED',
} as const;

export const SubscriptionStatus = {
  Pending: 'PENDING',
  Active: 'ACTIVE',
  Exhausted: 'EXHAUSTED',
  Expired: 'EXPIRED',
  Cancelled: 'CANCELLED',
} as const;

export const ReservationStatus = {
  Reserved: 'RESERVED',
  Finalized: 'FINALIZED',
  Released: 'RELEASED',
} as const;

export const ALLOWED_SCREENSHOT_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

export type RideDirection = 'forward' | 'reverse';
export type PackageDirection = 'both' | RideDirection;

export type SubscriptionLedger = {
  id: string;
  userId: string;
  packageId: string;
  routeId: string | null;
  routeName?: string | null;
  direction: PackageDirection;
  vehicleKind: string | null;
  status: string;
  ridesTotal: number;
  ridesUsed: number;
  ridesReserved: number;
  expiresAt: Date | null;
};

export type RideContext = {
  routeId: string;
  direction: RideDirection;
  vehicleKind?: string | null;
  now: Date;
  /** Stop names plus the trip route title, used when the package line is the same corridor under another name. */
  stopNames?: string[];
};

export function normalizeTransactionReference(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/\s+/g, '').toUpperCase();
}

export function normalizeDirection(raw: string | null | undefined): PackageDirection {
  const value = (raw ?? 'both').trim().toLowerCase();
  if (value === 'forward' || value === 'one_way' || value === 'one-way') return 'forward';
  if (value === 'reverse') return 'reverse';
  return 'both';
}

/** وصال sits inside El Shorouk, and catalog lines keep the city name. */
const SAME_CORRIDOR = [['وصال', 'wesal', 'الشروق', 'shorouk', 'el shorouk']];

function corridorHit(raw: string): number {
  const text = normalizePlaceName(raw);
  if (!text) return -1;
  return SAME_CORRIDOR.findIndex((group) =>
    group.some((token) => text.includes(normalizePlaceName(token))),
  );
}

function samePlace(left: string, right: string): boolean {
  if (placesCompatible(left, right)) return true;
  const a = corridorHit(left);
  return a >= 0 && a === corridorHit(right);
}

export function lineLabels(raw?: string | null): string[] {
  return (raw ?? '')
    .split(/\s+[-–—]\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

/** Package "El Shorouk City - Helwan" covers the bookable "مدينة وصال - حلوان" line. */
export function coversNamedLine(
  packageRouteName?: string | null,
  stopNames?: string[] | null,
): boolean {
  const ends = lineLabels(packageRouteName);
  if (ends.length < 2) return false;
  const stops = (stopNames ?? []).map((name) => name.trim()).filter(Boolean);
  if (stops.length < 2) return false;
  const origin = ends[0];
  const destination = ends[ends.length - 1];
  const originIndex = stops.findIndex((stop) => samePlace(origin, stop));
  if (originIndex < 0) return false;
  return stops.some((stop, index) => index !== originIndex && samePlace(destination, stop));
}

export function tripDirection(
  originOrder?: number | null,
  destinationOrder?: number | null,
): RideDirection {
  if (originOrder == null || destinationOrder == null) return 'forward';
  return destinationOrder < originOrder ? 'reverse' : 'forward';
}

export function remainingRides(sub: Pick<SubscriptionLedger, 'ridesTotal' | 'ridesUsed' | 'ridesReserved'>): number {
  if (sub.ridesTotal <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, sub.ridesTotal - sub.ridesUsed - sub.ridesReserved);
}

export function isPackageFunded(
  paymentMethod?: string | null,
  usesSubscriptionCredit?: boolean | null,
): boolean {
  if (usesSubscriptionCredit) return true;
  const value = (paymentMethod ?? '').trim().toLowerCase();
  return value === 'subscription' || value === 'package' || value === 'باقة';
}

export function countsAsCaptainCash(
  paymentMethod?: string | null,
  usesSubscriptionCredit?: boolean | null,
): boolean {
  return !isPackageFunded(paymentMethod, usesSubscriptionCredit);
}

export function validateScreenshot(mime: string, size: number): string | null {
  const normalized = mime.trim().toLowerCase();
  if (!ALLOWED_SCREENSHOT_MIME.includes(normalized as (typeof ALLOWED_SCREENSHOT_MIME)[number])) {
    return 'UNSUPPORTED_SCREENSHOT';
  }
  if (size <= 0 || size > MAX_SCREENSHOT_BYTES) return 'SCREENSHOT_TOO_LARGE';
  return null;
}

export function submitPurchaseStatus(current: string): string {
  if (
    current !== PurchaseStatus.PendingPayment &&
    current !== PurchaseStatus.Rejected &&
    current !== PurchaseStatus.PaymentSubmitted
  ) {
    throw new Error('INVALID_SUBMIT');
  }
  return PurchaseStatus.PendingVerification;
}

export function canActivatePurchase(status: string): boolean {
  return status === PurchaseStatus.Paid;
}

export function approvePurchase(input: {
  status: string;
  transactionReference: string | null | undefined;
  knownReferences: ReadonlySet<string>;
  alreadyHasSubscription: boolean;
}): { status: typeof PurchaseStatus.Paid; activate: boolean } {
  if (input.status === PurchaseStatus.Paid || input.alreadyHasSubscription) {
    return { status: PurchaseStatus.Paid, activate: false };
  }
  if (
    input.status !== PurchaseStatus.PendingVerification &&
    input.status !== PurchaseStatus.PaymentSubmitted
  ) {
    throw new Error('INVALID_APPROVE');
  }
  const ref = normalizeTransactionReference(input.transactionReference);
  if (!ref) throw new Error('MISSING_REF');
  if (input.knownReferences.has(ref)) throw new Error('DUPLICATE_REF');
  return { status: PurchaseStatus.Paid, activate: true };
}

export function rejectPurchase(status: string): { changed: boolean } {
  if (status === PurchaseStatus.Paid) throw new Error('PAID_LOCKED');
  if (status === PurchaseStatus.Rejected) return { changed: false };
  if (
    status !== PurchaseStatus.PendingVerification &&
    status !== PurchaseStatus.PaymentSubmitted &&
    status !== PurchaseStatus.PendingPayment
  ) {
    throw new Error('INVALID_REJECT');
  }
  return { changed: true };
}

export function isEligible(sub: SubscriptionLedger, ctx: RideContext): boolean {
  if (sub.status !== SubscriptionStatus.Active) return false;
  if (sub.expiresAt != null && sub.expiresAt.getTime() < ctx.now.getTime()) return false;
  const sameRoute = sub.routeId != null && sub.routeId === ctx.routeId;
  if (!sameRoute && !coversNamedLine(sub.routeName, ctx.stopNames)) return false;
  if (sub.direction !== 'both' && sub.direction !== ctx.direction) return false;
  const wanted = (ctx.vehicleKind ?? '').trim().toLowerCase();
  const owned = (sub.vehicleKind ?? '').trim().toLowerCase();
  if (owned && wanted && owned !== wanted) return false;
  return remainingRides(sub) > 0;
}

export function pickSubscription(
  subs: SubscriptionLedger[],
  ctx: RideContext,
  preferredId?: string | null,
): SubscriptionLedger | null {
  const eligible = subs.filter((sub) => isEligible(sub, ctx));
  if (preferredId) {
    const preferred = eligible.find((sub) => sub.id === preferredId);
    if (preferred) return preferred;
  }
  eligible.sort((a, b) => {
    const ae = a.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const be = b.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (ae !== be) return ae - be;
    return a.id.localeCompare(b.id);
  });
  return eligible[0] ?? null;
}

export function applyReserve(sub: SubscriptionLedger): SubscriptionLedger {
  if (!isEligible(sub, {
    routeId: sub.routeId ?? '',
    direction: sub.direction === 'reverse' ? 'reverse' : 'forward',
    vehicleKind: sub.vehicleKind,
    now: new Date(0),
  }) && remainingRides(sub) <= 0) {
    throw new Error('OVERSPEND');
  }
  if (sub.status !== SubscriptionStatus.Active || remainingRides(sub) <= 0) {
    throw new Error('OVERSPEND');
  }
  return { ...sub, ridesReserved: sub.ridesReserved + 1 };
}

export function applyFinalize(
  sub: SubscriptionLedger,
  reservationStatus: string,
): { subscription: SubscriptionLedger; reservationStatus: string; deducted: boolean } {
  if (reservationStatus === ReservationStatus.Finalized) {
    return { subscription: sub, reservationStatus, deducted: false };
  }
  if (reservationStatus !== ReservationStatus.Reserved) {
    throw new Error('NOT_RESERVED');
  }
  const ridesReserved = Math.max(0, sub.ridesReserved - 1);
  const ridesUsed = sub.ridesUsed + 1;
  const status =
    sub.ridesTotal > 0 && ridesUsed >= sub.ridesTotal
      ? SubscriptionStatus.Exhausted
      : sub.status;
  return {
    subscription: { ...sub, ridesReserved, ridesUsed, status },
    reservationStatus: ReservationStatus.Finalized,
    deducted: true,
  };
}

export function applyRelease(
  sub: SubscriptionLedger,
  reservationStatus: string,
): { subscription: SubscriptionLedger; reservationStatus: string; released: boolean } {
  if (
    reservationStatus === ReservationStatus.Released ||
    reservationStatus === ReservationStatus.Finalized
  ) {
    return { subscription: sub, reservationStatus, released: false };
  }
  if (reservationStatus !== ReservationStatus.Reserved) {
    throw new Error('NOT_RESERVED');
  }
  return {
    subscription: {
      ...sub,
      ridesReserved: Math.max(0, sub.ridesReserved - 1),
    },
    reservationStatus: ReservationStatus.Released,
    released: true,
  };
}
