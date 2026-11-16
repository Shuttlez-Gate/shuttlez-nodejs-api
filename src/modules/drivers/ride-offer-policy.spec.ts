import { JwtService } from '@nestjs/jwt';
import { RideRequestStatus } from '../../common/enums';
import { ErrorCodes } from '../../common/error-codes';
import {
  decideRideAccept,
  OfferAudience,
  evaluateOfferEligibility,
  LOCATION_FRESH_MS,
  NEAR_COMPLETION_MINUTES,
  offerVehicleCompatible,
  selectBroadcastRecipients,
} from './ride-offer-policy';
import { resolveVerifiedUserId, SocketIdentity } from '../realtime/socket-identity';

const captain = { latitude: 30.05, longitude: 31.25 };
const nearbyPickup = { latitude: 30.06, longitude: 31.26 };
const farPickup = { latitude: 30.5, longitude: 31.8 };
const now = 1_700_000_000_000;

function offer(
  overrides: Partial<Parameters<typeof evaluateOfferEligibility>[0]> = {},
) {
  return evaluateOfferEligibility({
    isActive: true,
    isOnline: true,
    hasActiveShuttle: false,
    hasActiveGroup: false,
    captainLatitude: captain.latitude,
    captainLongitude: captain.longitude,
    pickupLatitude: nearbyPickup.latitude,
    pickupLongitude: nearbyPickup.longitude,
    radiusKm: 5,
    nowMs: now,
    ...overrides,
  });
}

describe('captain offer eligibility truth table', () => {
  it('1. no current trip and pickup nearby is visible and actionable', () => {
    const decision = offer();
    expect(decision.visible).toBe(true);
    expect(decision.actionable).toBe(true);
    expect(decision.reason).toBe('eligible');
  });

  it('2. no current trip and pickup far away is rejected', () => {
    const decision = offer({
      pickupLatitude: farPickup.latitude,
      pickupLongitude: farPickup.longitude,
    });
    expect(decision.visible).toBe(false);
    expect(decision.actionable).toBe(false);
    expect(decision.reason).toBe('pickup_too_far');
  });

  it('3. active ride with more than five minutes remaining is rejected', () => {
    const decision = offer({
      activeRideStatus: RideRequestStatus.InProgress,
      remainingMinutes: NEAR_COMPLETION_MINUTES + 1,
    });
    expect(decision.reason).toBe('ride_not_finishing');
    expect(decision.actionable).toBe(false);
  });

  it('4. active ride with about five minutes remaining is actionable when the destination is near the pickup', () => {
    const decision = offer({
      activeRideStatus: RideRequestStatus.InProgress,
      remainingMinutes: NEAR_COMPLETION_MINUTES,
      captainLatitude: 29.0,
      captainLongitude: 30.0,
      activeRideDestinationLatitude: nearbyPickup.latitude,
      activeRideDestinationLongitude: nearbyPickup.longitude,
    });
    expect(decision.reason).toBe('eligible');
    expect(decision.actionable).toBe(true);
  });

  it('5. active ride almost completed uses the same five-minute rule', () => {
    const decision = offer({
      activeRideStatus: RideRequestStatus.InProgress,
      remainingMinutes: 0,
      activeRideDestinationLatitude: nearbyPickup.latitude,
      activeRideDestinationLongitude: nearbyPickup.longitude,
    });
    expect(decision.reason).toBe('eligible');
  });

  it('6. current ride completed during a pending offer leaves the captain eligible', () => {
    const decision = offer({ activeRideStatus: null, remainingMinutes: null });
    expect(decision.reason).toBe('eligible');
  });

  it('7. current ride cancelled during a pending offer leaves the captain eligible', () => {
    const decision = offer({ activeRideStatus: RideRequestStatus.Cancelled });
    expect(decision.reason).toBe('eligible');
  });

  it('8. captain going offline is rejected', () => {
    expect(offer({ isOnline: false }).reason).toBe('offline');
    expect(offer({ isActive: false }).reason).toBe('inactive');
  });

  it('9. stale captain location is not eligible', () => {
    const decision = offer({
      enforceLocationFreshness: true,
      locationUpdatedAtMs: now - LOCATION_FRESH_MS - 1,
    });
    expect(decision.reason).toBe('stale_location');
    expect(decision.actionable).toBe(false);
  });

  it('10. several nearby captains are all eligible and a far one is not', () => {
    const recipients = selectBroadcastRecipients({
      pickupLatitude: nearbyPickup.latitude,
      pickupLongitude: nearbyPickup.longitude,
      requestedVehicleKind: 'private_car',
      nowMs: now,
      presences: [
        {
          userId: 'near-a',
          latitude: captain.latitude,
          longitude: captain.longitude,
          vehicleKind: 'sedan',
          updatedAtMs: now,
        },
        {
          userId: 'near-b',
          latitude: 30.055,
          longitude: 31.255,
          vehicleKind: 'private_car',
          updatedAtMs: now,
        },
        {
          userId: 'far',
          latitude: farPickup.latitude,
          longitude: farPickup.longitude,
          vehicleKind: 'sedan',
          updatedAtMs: now,
        },
      ],
    });
    expect(recipients.map((item) => item.userId).sort()).toEqual(['near-a', 'near-b']);
  });

  it('does not broadcast when pickup coordinates are missing', () => {
    expect(
      selectBroadcastRecipients({
        pickupLatitude: null,
        pickupLongitude: null,
        nowMs: now,
        presences: [
          {
            userId: 'any',
            latitude: captain.latitude,
            longitude: captain.longitude,
            updatedAtMs: now,
          },
        ],
      }),
    ).toEqual([]);
  });

  it('hides a scooter request from a car captain and keeps it for a scooter captain', () => {
    expect(offerVehicleCompatible('scooter', 'sedan')).toBe(false);
    expect(offerVehicleCompatible('scooter', 'scooter')).toBe(true);
    expect(offerVehicleCompatible('private_car', 'sedan')).toBe(true);
    expect(offerVehicleCompatible('group_car', 'sedan')).toBe(true);
    expect(offer({ requestedVehicleKind: 'scooter', captainVehicleKind: 'sedan' }).reason).toBe(
      'vehicle_mismatch',
    );
  });

  it('blocks a captain who is still driving to the current pickup', () => {
    expect(offer({ activeRideStatus: RideRequestStatus.Assigned }).reason).toBe('en_route_to_pickup');
  });

  it('blocks when an in-progress ETA cannot be calculated', () => {
    expect(
      offer({ activeRideStatus: RideRequestStatus.InProgress, remainingMinutes: null }).reason,
    ).toBe('eta_unknown');
  });
});

describe('ride accept transitions', () => {
  const actor = 'captain-a';

  it('claims an open unassigned request', () => {
    expect(
      decideRideAccept({
        status: RideRequestStatus.Requested,
        rideDriverId: null,
        actorDriverId: actor,
      }).action,
    ).toBe('claim');
  });

  it('is idempotent when the same captain accepts twice', () => {
    expect(
      decideRideAccept({
        status: RideRequestStatus.Assigned,
        rideDriverId: actor,
        actorDriverId: actor,
      }).action,
    ).toBe('idempotent');
  });

  it('rejects a request already assigned to another captain', () => {
    const decision = decideRideAccept({
      status: RideRequestStatus.Assigned,
      rideDriverId: 'captain-b',
      actorDriverId: actor,
    });
    expect(decision.action).toBe('reject');
    if (decision.action === 'reject') expect(decision.code).toBe(ErrorCodes.RideNotAssignable);
  });

  it('rejects cancelled, completed, and in-progress rides without rewinding them', () => {
    for (const status of [
      RideRequestStatus.Cancelled,
      RideRequestStatus.Completed,
      RideRequestStatus.InProgress,
    ]) {
      const decision = decideRideAccept({
        status,
        rideDriverId: actor,
        actorDriverId: actor,
      });
      expect(decision.action).toBe('reject');
    }
  });
});

describe('socket identity', () => {
  const secret = 'test-secret-test-secret-test-secret-12';

  function signed(sub: string) {
    return new JwtService({ secret }).sign(
      { sub },
      { secret, issuer: 'Shuttlez', audience: 'ShuttlezApp', expiresIn: '5m' },
    );
  }

  it('rejects a claimed user id that does not match the verified token', () => {
    expect(resolveVerifiedUserId('user-a', 'user-b')).toBeNull();
    expect(resolveVerifiedUserId('user-a', 'user-a')).toBe('user-a');
    expect(resolveVerifiedUserId('', 'user-a')).toBeNull();
  });

  it('does not accept an unsigned payload as a driver identity', async () => {
    const identity = new SocketIdentity(new JwtService({ secret }), {
      getOrThrow: () => secret,
      get: (_key: string, fallback?: string) => fallback,
    } as never);
    const forged = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'victim-user' })).toString('base64url');
    const client = {
      handshake: { auth: { token: `${forged}.${body}.`, userId: 'victim-user' }, query: {}, headers: {} },
    } as never;
    await expect(identity.userId(client, 'victim-user')).resolves.toBeNull();
  });

  it('accepts a signed token and ignores a matching claim only', async () => {
    const identity = new SocketIdentity(new JwtService({ secret }), {
      getOrThrow: () => secret,
      get: (_key: string, fallback?: string) => fallback,
    } as never);
    const token = signed('captain-user');
    const client = { handshake: { auth: { token }, query: {}, headers: {} } } as never;
    await expect(identity.userId(client)).resolves.toBe('captain-user');
    await expect(identity.userId(client, 'someone-else')).resolves.toBeNull();
  });
});

describe('offer audience', () => {
  it('notifies only captains who received the offer, then forgets them', () => {
    const audience = new OfferAudience();
    audience.remember('ride-1', ['captain-a', 'captain-b']);
    audience.remember('ride-1', ['captain-a']);
    expect(audience.targets('ride-1').sort()).toEqual(['captain-a', 'captain-b']);
    expect(audience.targets('ride-1', ['captain-c']).sort()).toEqual([
      'captain-a',
      'captain-b',
      'captain-c',
    ]);
    audience.forget('ride-1');
    expect(audience.targets('ride-1')).toEqual([]);
  });

  it('does not let a second cancellation grow a new audience', () => {
    const audience = new OfferAudience();
    audience.remember('ride-1', ['captain-a']);
    audience.forget('ride-1');
    expect(audience.targets('ride-1', ['captain-a'])).toEqual(['captain-a']);
    audience.forget('ride-1');
    expect(audience.targets('ride-2')).toEqual([]);
  });
});
