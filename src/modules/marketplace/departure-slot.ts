import { Prisma } from '@prisma/client';
import {
  DEFAULT_OPERATIONAL_TIMEZONE,
  getZonedParts,
} from '../../common/utils/operational-clock';

/** Separates this lock from single-key advisory locks used by bookings. */
export const CAPTAIN_TRIP_LOCK_CLASS = 814201;

/**
 * Logical captain-route departure: Africa/Cairo calendar day and minute.
 * Seconds inside that minute are the same departure.
 */
export function departureSlotFor(date: Date): string {
  const parts = getZonedParts(date, DEFAULT_OPERATIONAL_TIMEZONE);
  const clock = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_OPERATIONAL_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return `${day} ${clock}`;
}

export function isDepartureSlotConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
