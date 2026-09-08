import { parseGender, parsePurpose, toProfileDto } from './auth.mapper';
import { Gender, OtpPurpose, UserType } from '../../common/enums';

describe('auth mapper', () => {
  it('maps gender to Arabic labels', () => {
    expect(
      toProfileDto({
        id: 'a',
        phone: '+201000000000',
        fullName: 'Ahmed',
        email: null,
        gender: Gender.Male,
        avatarUrl: null,
        ratingAverage: 4.5,
        ratingCount: 2,
        userType: UserType.Passenger,
      }).gender,
    ).toBe('ذكر');
  });

  it('parses purpose and gender', () => {
    expect(parsePurpose('register')).toBe(OtpPurpose.Register);
    expect(parsePurpose('login')).toBe(OtpPurpose.Login);
    expect(parseGender('female')).toBe(Gender.Female);
    expect(parseGender('أنثى')).toBe(Gender.Female);
  });
});
