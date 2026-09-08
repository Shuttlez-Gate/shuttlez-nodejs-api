import { AppException } from '../../common/exceptions/app.exception';
import { Gender, OtpPurpose, UserType } from '../../common/enums';
import { UserProfileDto } from './auth.dto';

export function toProfileDto(user: {
  id: string;
  phone: string;
  fullName: string | null;
  email: string | null;
  gender: number | null;
  avatarUrl: string | null;
  ratingAverage: { toNumber(): number } | number;
  ratingCount: number;
  userType: number;
}): UserProfileDto {
  const rating =
    typeof user.ratingAverage === 'number'
      ? user.ratingAverage
      : user.ratingAverage.toNumber();

  return {
    id: user.id,
    phone: user.phone,
    fullName: user.fullName,
    email: user.email,
    gender:
      user.gender === Gender.Male
        ? 'ذكر'
        : user.gender === Gender.Female
          ? 'أنثى'
          : null,
    avatarUrl: user.avatarUrl,
    ratingAverage: rating,
    ratingCount: user.ratingCount,
    userType: userTypeNameLower(user.userType),
  };
}

function userTypeNameLower(value: number): string {
  switch (value) {
    case UserType.Driver:
      return 'driver';
    case UserType.Admin:
      return 'admin';
    default:
      return 'passenger';
  }
}

export function parseGender(gender?: string | null): number | null {
  const key = gender?.trim().toLowerCase();
  switch (key) {
    case 'male':
    case 'ذكر':
      return Gender.Male;
    case 'female':
    case 'أنثى':
      return Gender.Female;
    default:
      return null;
  }
}

export function parsePurpose(purpose?: string): OtpPurpose {
  switch ((purpose ?? '').trim().toLowerCase()) {
    case 'register':
      return OtpPurpose.Register;
    case 'social-link':
      return OtpPurpose.SocialLink;
    default:
      return OtpPurpose.Login;
  }
}

export const SocialAuthProvider = {
  Google: 'google',
  Facebook: 'facebook',
} as const;

export function normalizeSocialProvider(provider: string): string {
  const value = provider.trim().toLowerCase();
  if (value === SocialAuthProvider.Google || value === SocialAuthProvider.Facebook) {
    return value;
  }
  throw new AppException(
    'مزود تسجيل الدخول غير مدعوم',
    400,
    'SOCIAL_PROVIDER_UNSUPPORTED',
  );
}
