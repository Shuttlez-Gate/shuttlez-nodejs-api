/**
 * Read-only classifiers for suspicious operational rows.
 * Not an HTTP diagnostic product. Does not repair data.
 */

export type IntegrityFinding = {
  entity: 'trip' | 'booking';
  kind: string;
  reason: string;
};

export function tripIntegrityFindings(trip: {
  routeId?: string | null;
  pricePerSeat?: number | null;
  isDeleted?: boolean;
}): IntegrityFinding[] {
  if (trip.isDeleted === true) return [];
  const findings: IntegrityFinding[] = [];
  if (!trip.routeId) {
    findings.push({
      entity: 'trip',
      kind: 'routeId',
      reason: 'Trip.routeId missing on a live trip',
    });
  }
  if (trip.pricePerSeat != null && Number(trip.pricePerSeat) <= 0) {
    findings.push({
      entity: 'trip',
      kind: 'pricePerSeat',
      reason: 'Trip.pricePerSeat <= 0 on a live trip',
    });
  }
  return findings;
}

export function bookingIntegrityFindings(booking: {
  tripId?: string | null;
  seatCount?: number | null;
  isDeleted?: boolean;
}): IntegrityFinding[] {
  if (booking.isDeleted === true) return [];
  const findings: IntegrityFinding[] = [];
  if (!booking.tripId) {
    findings.push({
      entity: 'booking',
      kind: 'tripId',
      reason: 'Booking.tripId missing on a live booking',
    });
  }
  if (booking.seatCount != null && Number(booking.seatCount) < 1) {
    findings.push({
      entity: 'booking',
      kind: 'seatCount',
      reason: 'Booking.seatCount < 1 on a live booking',
    });
  }
  return findings;
}
