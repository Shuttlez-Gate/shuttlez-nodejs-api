import {
  consecutiveSegmentKeys,
  remainingForRange,
  segmentPrice,
  type SegmentSeatRow,
} from './segment-occupancy';

describe('segment occupancy', () => {
  it('booking A→C occupies AB and BC', () => {
    expect(consecutiveSegmentKeys(0, 2)).toEqual([
      { fromOrder: 0, toOrder: 1 },
      { fromOrder: 1, toOrder: 2 },
    ]);
  });

  it('does not create a key for the same stop', () => {
    expect(consecutiveSegmentKeys(1, 1)).toEqual([]);
  });

  it('remaining is the bottleneck across touched segments', () => {
    const segments: SegmentSeatRow[] = [
      { fromOrder: 0, toOrder: 1, remainingSeats: 4 },
      { fromOrder: 1, toOrder: 2, remainingSeats: 1 },
      { fromOrder: 2, toOrder: 3, remainingSeats: 4 },
    ];
    expect(remainingForRange(segments, 0, 2)).toBe(1);
    expect(remainingForRange(segments, 0, 1)).toBe(4);
    expect(remainingForRange(segments, 1, 3)).toBe(1);
  });

  it('returns 0 when a touched segment is missing', () => {
    const segments: SegmentSeatRow[] = [
      { fromOrder: 0, toOrder: 1, remainingSeats: 4 },
    ];
    expect(remainingForRange(segments, 0, 2)).toBe(0);
  });

  it('prices a partial segment proportionally to stop span', () => {
    expect(segmentPrice(90, 0, 1, 0, 3)).toBe(30);
    expect(segmentPrice(90, 0, 3, 0, 3)).toBe(90);
  });
});
