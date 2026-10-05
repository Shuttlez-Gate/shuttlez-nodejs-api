import { RecurrenceKind } from '../../common/enums';
import { getZonedParts, operationalWeekday, zonedWallTimeToUtc } from '../../common/utils/operational-clock';
import { cairoDateKey } from '../bookings/rider-history-bucket';
import { occurrenceDates, parseDaysOfWeek, parseRecurrenceKind, daysForScheduleType } from './recurrence';
import { instancesOnDate } from './route-match';

describe('recurrence', () => {
  it('parses kind aliases', () => {
    expect(parseRecurrenceKind('once')).toBe(RecurrenceKind.Once);
    expect(parseRecurrenceKind('one-time')).toBe(RecurrenceKind.Once);
    expect(parseRecurrenceKind('weekly')).toBe(RecurrenceKind.Weekly);
    expect(parseRecurrenceKind('daily')).toBe(RecurrenceKind.Weekly);
    expect(parseRecurrenceKind('specific-days')).toBe(RecurrenceKind.Weekly);
    expect(parseRecurrenceKind('range')).toBe(RecurrenceKind.DateRange);
  });

  it('daily Oct 5 through Oct 10 includes the end date in Cairo', () => {
    const at = zonedWallTimeToUtc(2026, 10, 5, 0, 30, 0, 'Africa/Cairo');
    const end = zonedWallTimeToUtc(2026, 10, 10, 0, 30, 0, 'Africa/Cairo');
    const dates = occurrenceDates({
      kind: RecurrenceKind.Weekly,
      scheduledAt: at,
      daysOfWeek: daysForScheduleType('daily'),
      rangeEnd: end,
    });
    expect(dates.map((date) => cairoDateKey(date))).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
    ]);
    const trips = dates.map((scheduledAt, index) => ({
      id: `trip-${index}`,
      scheduledAt,
    }));
    const onSeventh = instancesOnDate(trips, '2026-10-07');
    expect(onSeventh.map((trip) => cairoDateKey(trip.scheduledAt))).toEqual(['2026-10-07']);
    expect(onSeventh.map((trip) => trip.id)).not.toContain('trip-0');
  });

  it('daily expands to every weekday', () => {
    expect(daysForScheduleType('daily')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const at = new Date('2026-10-04T07:30:00.000Z');
    const dates = occurrenceDates({
      kind: RecurrenceKind.Weekly,
      scheduledAt: at,
      daysOfWeek: daysForScheduleType('daily'),
      rangeEnd: new Date('2026-10-18T00:00:00.000Z'),
    });
    expect(dates.length).toBe(15);
    expect(new Set(dates.map((d) => d.getUTCDay())).size).toBe(7);
  });

  it('range without selected days uses every day', () => {
    expect(daysForScheduleType('range')).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('generates a single occurrence for once', () => {
    const at = new Date('2026-09-14T08:30:00.000Z');
    expect(occurrenceDates({ kind: RecurrenceKind.Once, scheduledAt: at })).toEqual([
      at,
    ]);
  });

  it('weekly uses selected weekdays and caps at 60', () => {
    const at = new Date('2026-09-14T08:30:00.000Z');
    const dates = occurrenceDates({
      kind: RecurrenceKind.Weekly,
      scheduledAt: at,
      daysOfWeek: parseDaysOfWeek([1, 3]),
    });
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.length).toBeLessThanOrEqual(60);
    const wall = getZonedParts(at, 'Africa/Cairo');
    expect(
      dates.every((date) => {
        const parts = getZonedParts(date, 'Africa/Cairo');
        return parts.hour === wall.hour && parts.minute === wall.minute;
      }),
    ).toBe(true);
    expect(dates.every((date) => [1, 3].includes(operationalWeekday(date, 'Africa/Cairo')))).toBe(
      true,
    );
  });
});
