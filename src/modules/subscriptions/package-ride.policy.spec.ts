import {
  PurchaseStatus,
  ReservationStatus,
  SubscriptionStatus,
  applyFinalize,
  applyRelease,
  applyReserve,
  approvePurchase,
  canActivatePurchase,
  countsAsCaptainCash,
  coversNamedLine,
  isEligible,
  normalizeTransactionReference,
  pickSubscription,
  rejectPurchase,
  remainingRides,
  submitPurchaseStatus,
  validateScreenshot,
  type SubscriptionLedger,
} from './package-ride.policy';

function sub(overrides: Partial<SubscriptionLedger> = {}): SubscriptionLedger {
  return {
    id: 'sub-a',
    userId: 'user-1',
    packageId: 'pkg-1',
    routeId: 'route-1',
    direction: 'both',
    vehicleKind: null,
    status: SubscriptionStatus.Active,
    ridesTotal: 2,
    ridesUsed: 0,
    ridesReserved: 0,
    expiresAt: new Date('2026-12-31T00:00:00.000Z'),
    ...overrides,
  };
}

const now = new Date('2026-11-20T12:00:00.000Z');
const ctx = {
  routeId: 'route-1',
  direction: 'forward' as const,
  vehicleKind: 'minibus',
  now,
};

describe('route package purchases and redemption', () => {
  it('lists an active route package as eligible and hides other routes', () => {
    expect(isEligible(sub(), ctx)).toBe(true);
    expect(isEligible(sub({ routeId: 'route-2' }), ctx)).toBe(false);
    expect(
      isEligible(sub({ routeId: 'route-2', routeName: 'El Shorouk City - Helwan' }), {
        ...ctx,
        routeId: 'wesal-helwan',
        stopNames: ['مدينة وصال', 'حلوان'],
      }),
    ).toBe(true);
    expect(
      coversNamedLine('El Shorouk City - Helwan', ['مدينة نصر', 'المعادي']),
    ).toBe(false);
    expect(isEligible(sub({ status: SubscriptionStatus.Expired }), ctx)).toBe(false);
    expect(isEligible(sub({ status: SubscriptionStatus.Exhausted, ridesUsed: 2 }), ctx)).toBe(false);
  });

  it('creates a purchase that stays unpaid until verification', () => {
    expect(canActivatePurchase(PurchaseStatus.PendingPayment)).toBe(false);
    expect(submitPurchaseStatus(PurchaseStatus.PendingPayment)).toBe(
      PurchaseStatus.PendingVerification,
    );
    expect(canActivatePurchase(PurchaseStatus.PendingVerification)).toBe(false);
  });

  it('rejects a second use of the same transaction reference and activates once', () => {
    const first = approvePurchase({
      status: PurchaseStatus.PendingVerification,
      transactionReference: ' ip 123 ',
      knownReferences: new Set(),
      alreadyHasSubscription: false,
    });
    expect(first).toEqual({ status: PurchaseStatus.Paid, activate: true });
    expect(() =>
      approvePurchase({
        status: PurchaseStatus.PendingVerification,
        transactionReference: 'IP123',
        knownReferences: new Set([normalizeTransactionReference('ip 123')]),
        alreadyHasSubscription: false,
      }),
    ).toThrow('DUPLICATE_REF');
    expect(
      approvePurchase({
        status: PurchaseStatus.Paid,
        transactionReference: 'IP123',
        knownReferences: new Set(['IP123']),
        alreadyHasSubscription: true,
      }).activate,
    ).toBe(false);
  });

  it('keeps remaining rides and blocks ineligible or concurrent overspend', () => {
    const open = sub({ ridesTotal: 1 });
    expect(remainingRides(open)).toBe(1);
    const held = applyReserve(open);
    expect(remainingRides(held)).toBe(0);
    expect(() => applyReserve(held)).toThrow('OVERSPEND');
    expect(isEligible(held, ctx)).toBe(false);
    expect(isEligible(sub({ direction: 'reverse' }), { ...ctx, direction: 'forward' })).toBe(false);
    expect(isEligible(sub({ vehicleKind: 'bus' }), ctx)).toBe(false);
  });

  it('picks the earliest expiring eligible package', () => {
    const later = sub({ id: 'later', expiresAt: new Date('2026-12-01T00:00:00.000Z') });
    const sooner = sub({ id: 'sooner', expiresAt: new Date('2026-11-25T00:00:00.000Z') });
    expect(pickSubscription([later, sooner], ctx)?.id).toBe('sooner');
  });

  it('deducts one ride on completion and ignores a duplicate completion', () => {
    const reserved = sub({ ridesTotal: 2, ridesReserved: 1 });
    const first = applyFinalize(reserved, ReservationStatus.Reserved);
    expect(first.deducted).toBe(true);
    expect(first.subscription.ridesUsed).toBe(1);
    expect(first.subscription.ridesReserved).toBe(0);
    const second = applyFinalize(first.subscription, first.reservationStatus);
    expect(second.deducted).toBe(false);
    expect(second.subscription.ridesUsed).toBe(1);
  });

  it('releases a reserved ride on cancellation and keeps a consumed ride', () => {
    const reserved = sub({ ridesReserved: 1 });
    const released = applyRelease(reserved, ReservationStatus.Reserved);
    expect(released.released).toBe(true);
    expect(released.subscription.ridesReserved).toBe(0);
    const again = applyRelease(released.subscription, released.reservationStatus);
    expect(again.released).toBe(false);
    const consumed = applyRelease(
      sub({ ridesUsed: 1, ridesReserved: 0 }),
      ReservationStatus.Finalized,
    );
    expect(consumed.released).toBe(false);
    expect(consumed.subscription.ridesUsed).toBe(1);
  });

  it('does not treat a package ride as captain cash and still accepts cash', () => {
    expect(countsAsCaptainCash('subscription', true)).toBe(false);
    expect(countsAsCaptainCash('cash', false)).toBe(true);
    expect(rejectPurchase(PurchaseStatus.PendingVerification).changed).toBe(true);
    expect(() => rejectPurchase(PurchaseStatus.Paid)).toThrow('PAID_LOCKED');
    expect(validateScreenshot('image/jpeg', 1024)).toBeNull();
    expect(validateScreenshot('application/pdf', 1024)).toBe('UNSUPPORTED_SCREENSHOT');
  });
});
