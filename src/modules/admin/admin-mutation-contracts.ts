import { TripStatus } from '../../common/enums';

/** Admin booking status patch writes only these fields. Not inventory. Not snapshots. */
export function adminBookingStatusWrite(status: number, updatedAt: Date) {
  return { status, updatedAt };
}

export function adminBookingStatusWrittenKeys(): string[] {
  return Object.keys(adminBookingStatusWrite(0, new Date(0))).sort();
}

export function canAdminCancelTrip(status: number): boolean {
  return status !== TripStatus.Completed && status !== TripStatus.Cancelled;
}

export function captainAssignmentWrite(currentStatus: number, driverId: string) {
  return {
    driverId,
    status:
      currentStatus === TripStatus.Scheduled
        ? TripStatus.DriverAssigned
        : currentStatus,
  };
}

export function captainUnassignmentWrite(currentStatus: number) {
  return {
    driverId: null as string | null,
    status:
      currentStatus === TripStatus.DriverAssigned
        ? TripStatus.Scheduled
        : currentStatus,
  };
}

/** Sequential Admin assigns have no version token. The last persisted driverId wins. */
export function lastCaptainWriteWins(writes: string[]): string {
  return writes[writes.length - 1];
}
