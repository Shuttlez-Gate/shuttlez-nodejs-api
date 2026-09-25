import { isConfirmedDemandPassenger } from './demand-confirmation';

describe('demand confirmation', () => {
  it('does not treat landing or waitlist signals as confirmed passengers', () => {
    expect(isConfirmedDemandPassenger('landing')).toBe(false);
    expect(isConfirmedDemandPassenger('waitlist')).toBe(false);
    expect(isConfirmedDemandPassenger('captain')).toBe(false);
    expect(isConfirmedDemandPassenger('app', 'pending')).toBe(false);
  });

  it('confirms only approved or converted app route requests', () => {
    expect(isConfirmedDemandPassenger('app', 'approved')).toBe(true);
    expect(isConfirmedDemandPassenger('app', 'converted')).toBe(true);
  });
});
