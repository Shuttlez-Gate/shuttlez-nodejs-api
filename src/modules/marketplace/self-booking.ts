/** Rider discovery must not offer a trip the viewer owns or drives. */
export function isSelfOwnedTrip(
  currentUserId: string,
  ownerUserId?: string | null,
  driverUserId?: string | null,
): boolean {
  return ownerUserId === currentUserId || driverUserId === currentUserId;
}

/**
 * Applied on the route query, before `take` / pagination.
 * One filter covers every generated instance of that captain route.
 */
export function captainRoutesNotOwnedBy(userId: string) {
  return {
    NOT: {
      ownerDriver: { userId },
    },
  };
}

/**
 * Applied on trip queries (shuttle and captain instances), before `take`.
 */
export function tripsNotOwnedByViewer(userId: string) {
  return {
    NOT: {
      OR: [
        { driver: { userId } },
        { route: { ownerDriver: { userId } } },
      ],
    },
  };
}

/** Captain management screens keep `ownerDriverId = me`. */
export function captainOwnsRoute(driverId: string) {
  return { ownerDriverId: driverId };
}

/** Same ownership gate as booking. There is no trip-favorite table today. */
export function riderMaySaveTrip(
  currentUserId: string,
  ownerUserId?: string | null,
  driverUserId?: string | null,
): boolean {
  return !isSelfOwnedTrip(currentUserId, ownerUserId, driverUserId);
}
