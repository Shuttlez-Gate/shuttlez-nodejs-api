import { RecurrenceKind } from '../../common/enums';
import { occurrenceDates, parseDaysOfWeek, parseRecurrenceKind, daysForScheduleType } from './recurrence';

describe('recurrence', () => {
  it('parses kind aliases', () => {
    expect(parseRecurrenceKind('once')).toBe(RecurrenceKind.Once);
    expect(parseRecurrenceKind('one-time')).toBe(RecurrenceKind.Once);
    expect(parseRecurrenceKind('weekly')).toBe(RecurrenceKind.Weekly);
    expect(parseRecurrenceKind('daily')).toBe(RecurrenceKind.Weekly);
    expect(parseRecurrenceKind('specific-days')).toBe(RecurrenceKind.Weekly);
    expect(parseRecurrenceKind('range')).toBe(RecurrenceKind.DateRange);
  });

  it('daily expands to every weekday', () => {
    expect(daysForScheduleType('daily')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const at = new Date('2026-10-04T07:30:00.000Z');
    const dates = occurrenceDates({
      kind: RecurrenceKind.Weekly,
      scheduledAt: at,
      daysOfWeek: daysForScheduleType('daily'),
    });
    expect(dates.length).toBeGreaterThan(7);
    expect(new Set(dates.map((d) => d.getUTCDay())).size).toBe(7);
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
    expect(dates.every((d) => d.getUTCHours() === 8 && d.getUTCMinutes() === 30)).toBe(
      true,
    );
    expect(dates.every((d) => [1, 3].includes(d.getUTCDay()))).toBe(true);
  });
});
