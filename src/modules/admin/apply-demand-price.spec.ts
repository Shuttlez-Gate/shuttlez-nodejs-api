import { resolveApplyDemandPrice } from './apply-demand-price';

describe('apply demand price', () => {
  it('rejects a missing price', () => {
    expect(resolveApplyDemandPrice(undefined)).toBeNull();
  });

  it('rejects null', () => {
    expect(resolveApplyDemandPrice(null)).toBeNull();
  });

  it('rejects 0', () => {
    expect(resolveApplyDemandPrice(0)).toBeNull();
  });

  it('rejects a negative price', () => {
    expect(resolveApplyDemandPrice(-5)).toBeNull();
  });

  it('accepts a valid positive price', () => {
    expect(resolveApplyDemandPrice(45.5)).toBe(45.5);
  });

  it('does not silently default an omitted price to 100', () => {
    expect(resolveApplyDemandPrice(undefined)).not.toBe(100);
    expect(resolveApplyDemandPrice(null)).not.toBe(100);
    expect(resolveApplyDemandPrice(100)).toBe(100);
  });
});
