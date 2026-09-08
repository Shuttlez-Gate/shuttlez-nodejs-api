import { normalizePhone } from './phone-normalizer';

describe('normalizePhone', () => {
  it('normalizes 20xxxxxxxxxx to E.164', () => {
    expect(normalizePhone('201012345678')).toBe('+201012345678');
  });

  it('normalizes 0xxxxxxxxxx', () => {
    expect(normalizePhone('01012345678')).toBe('+201012345678');
  });

  it('normalizes 10-digit numbers starting with 1', () => {
    expect(normalizePhone('1012345678')).toBe('+201012345678');
  });

  it('keeps already international numbers', () => {
    expect(normalizePhone('+201012345678')).toBe('+201012345678');
  });
});
