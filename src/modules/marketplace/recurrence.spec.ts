import { RecurrenceKind } from '../../common/enums';
import { occurrenceDates, parseDaysOfWeek, parseRecurrenceKind } from './recurrence';

describe('recurrence', () => {
  it('parses kind aliases', () => {
    expect(parseRecurrenceKind('once')).toBe(RecurrenceKind.Once);
    expect(parseRecurrenceKind('weekly')).toBe(RecurrenceKind.Weekly);
    expect(parseRecurrenceKind('range')).toBe(RecurrenceKind.DateRange);
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
