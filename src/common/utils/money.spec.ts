import { splitEarnings } from './money';

describe('commission snapshot', () => {
  it('keeps the original split after a later pricing/commission percent change', () => {
    const bookedAtCreation = splitEarnings(100, 10);
    expect(bookedAtCreation.commissionRate).toBe(0.1);
    expect(bookedAtCreation.commissionAmount).toBe(10);
    expect(bookedAtCreation.captainEarnings).toBe(90);

    const laterRulePercent = 25;
    const ifRecomputedNow = splitEarnings(100, laterRulePercent);
    expect(ifRecomputedNow.commissionAmount).toBe(25);

    expect(bookedAtCreation.commissionAmount).toBe(10);
    expect(bookedAtCreation.commissionRate).toBe(0.1);
    expect(bookedAtCreation.captainEarnings).toBe(90);
  });
});
