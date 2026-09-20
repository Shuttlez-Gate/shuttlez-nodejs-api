import { RecurrenceKind } from '../../common/enums';
import { AppException } from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import { addDays } from '../../common/utils/date.util';

export const MAX_GENERATED_TRIPS = 60;

export function parseRecurrenceKind(raw?: string | null): RecurrenceKind {
  const value = (raw ?? 'once').trim().toLowerCase();
  if (value === '' || value === 'once') {
    return RecurrenceKind.Once;
  }
  if (value === 'weekly') {
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

  const days =
    input.daysOfWeek && input.daysOfWeek.length > 0
      ? input.daysOfWeek
      : [time.getUTCDay()];

  if (input.kind === RecurrenceKind.Weekly) {
    return collectDates(time, addDays(startOfUtcDay(time), 8 * 7), days);
  }

  const rangeStart = input.rangeStart ?? time;
  const rangeEnd = input.rangeEnd;
  if (!rangeEnd || rangeEnd < rangeStart) {
    throw new AppException(
      'مدى التواريخ غير صالح',
      400,
      ErrorCodes.InvalidRecurrence,
    );
  }
  return collectDates(atTime(rangeStart, time), atTime(rangeEnd, time), days);
}

function collectDates(from: Date, until: Date, daysOfWeek: number[]): Date[] {
  const dates: Date[] = [];
  let cursor = startOfUtcDay(from);
  const end = startOfUtcDay(until);
  const hours = from.getUTCHours();
  const minutes = from.getUTCMinutes();
  while (cursor.getTime() <= end.getTime() && dates.length < MAX_GENERATED_TRIPS) {
    if (daysOfWeek.includes(cursor.getUTCDay())) {
      dates.push(
        new Date(
          Date.UTC(
            cursor.getUTCFullYear(),
            cursor.getUTCMonth(),
            cursor.getUTCDate(),
            hours,
            minutes,
            0,
            0,
          ),
        ),
      );
    }
    cursor = addDays(cursor, 1);
  }
  if (dates.length === 0) {
    throw new AppException(
      'لا توجد أيام مطابقة للتكرار',
      400,
      ErrorCodes.InvalidRecurrence,
    );
  }
  return dates;
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function atTime(date: Date, time: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      time.getUTCHours(),
      time.getUTCMinutes(),
      0,
      0,
    ),
  );
}
