import { RecurrenceKind } from '../../common/enums';
import { AppException } from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import {
  addOperationalDays,
  DEFAULT_OPERATIONAL_TIMEZONE,
  enumerateOperationalSchedule,
  getZonedParts,
  operationalDayKey,
  operationalWeekday,
} from '../../common/utils/operational-clock';

export const MAX_GENERATED_TRIPS = 60;

export function parseRecurrenceKind(raw?: string | null): RecurrenceKind {
  const value = (raw ?? 'once').trim().toLowerCase();
  if (value === '' || value === 'once' || value === 'onetime' || value === 'one-time') {
    return RecurrenceKind.Once;
  }
  if (
    value === 'weekly' ||
    value === 'daily' ||
    value === 'specific' ||
    value === 'specificdays' ||
    value === 'specific-days'
  ) {
    return RecurrenceKind.Weekly;
  }
  if (value === 'range' || value === 'daterange' || value === 'date-range') {
    return RecurrenceKind.DateRange;
  }
  throw new AppException('نوع التكرار غير صالح', 400, ErrorCodes.InvalidRecurrence);
}

export function parseDaysOfWeek(raw?: number[] | string | null): number[] {
  if (raw == null || raw === '') {
    return [];
  }
  const values = Array.isArray(raw)
    ? raw
    : raw
        .split(',')
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isInteger(item));
  const unique = [...new Set(values.filter((day) => day >= 0 && day <= 6))];
  return unique.sort((a, b) => a - b);
}

export function daysOfWeekCsv(days: number[]): string | null {
  return days.length > 0 ? days.join(',') : null;
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Maps admin/captain schedule type to recurrence days. Daily = every weekday. */
export function daysForScheduleType(
  scheduleType?: string | null,
  daysOfWeek?: number[] | string | null,
): number[] {
  const value = (scheduleType ?? '').trim().toLowerCase();
  if (value === 'daily') {
    return [...ALL_DAYS];
  }
  const selected = parseDaysOfWeek(daysOfWeek);
  if (value === 'range' && selected.length === 0) {
    return [...ALL_DAYS];
  }
  return selected;
}

/**
 * Expands a route template into bookable instants.
 * Calendar days and weekdays are Africa/Cairo. The end date is included.
 * The wall-clock time is the Cairo time of `scheduledAt`, copied onto each day.
 */
export function occurrenceDates(input: {
  kind: RecurrenceKind;
  scheduledAt: Date;
  daysOfWeek?: number[];
  rangeStart?: Date | null;
  rangeEnd?: Date | null;
}): Date[] {
  const time = input.scheduledAt;
  if (input.kind === RecurrenceKind.Once) {
    return [time];
  }

  const timeZone = DEFAULT_OPERATIONAL_TIMEZONE;
  const days =
    input.daysOfWeek && input.daysOfWeek.length > 0
      ? input.daysOfWeek
      : [operationalWeekday(time, timeZone)];

  const from =
    input.kind === RecurrenceKind.Weekly
      ? (input.rangeStart ?? time)
      : (input.rangeStart ?? time);
  let until = input.rangeEnd ?? null;
  if (input.kind === RecurrenceKind.DateRange) {
    if (!until || until.getTime() < from.getTime()) {
      throw new AppException(
        'مدى التواريخ غير صالح',
        400,
        ErrorCodes.InvalidRecurrence,
      );
    }
  } else if (!until) {
    until = addOperationalDays(from, 8 * 7, timeZone);
  }

  const wall = getZonedParts(time, timeZone);
  const clock = `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`;
  const dates = enumerateOperationalSchedule({
    startDate: operationalDayKey(from, timeZone),
    endDate: operationalDayKey(until, timeZone),
    times: [clock],
    daysOfWeek: days,
    timeZone,
  }).slice(0, MAX_GENERATED_TRIPS);
  if (dates.length === 0) {
    throw new AppException(
      'لا توجد أيام مطابقة للتكرار',
      400,
      ErrorCodes.InvalidRecurrence,
    );
  }
  return dates;
}
