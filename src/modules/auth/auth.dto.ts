import { IsIn, IsNotEmpty, IsOptional, IsString, Length, Matches, MinLength } from 'class-validator';

export class SendOtpRequest {
  @IsNotEmpty()
  @Matches(/^\+?20\d{10}$/, {
    message: 'رقم الهاتف غير صالح. استخدم صيغة مصرية مثل +2010xxxxxxxx',
  })
  phone!: string;

  @IsOptional()
  @IsIn(['login', 'register', 'social-link'], {
    message: 'الغرض يجب أن يكون login أو register أو social-link',
  })
  purpose: string = 'login';

  @IsOptional()
  @IsString()
  client?: string;
}

export class VerifyOtpRequest {
  @IsNotEmpty()
  phone!: string;

  @IsNotEmpty()
  @Length(4, 4)
  @Matches(/^\d{4}$/, { message: 'رمز التحقق يجب أن يكون 4 أرقام' })
  code!: string;

  @IsOptional()
  purpose: string = 'login';

  @IsOptional()
  @IsString()
  client?: string;
}

export class RegisterRequest {
  @IsNotEmpty()
  phone!: string;

  @IsNotEmpty()
  @MinLength(3)
  fullName!: string;

  @IsOptional()
  email?: string;

  @IsIn(['male', 'female', 'ذكر', 'أنثى'], { message: 'النوع غير صالح' })
  gender!: string;

  @Length(4, 4)
  code!: string;

  @IsOptional()
  userType?: string;

  @IsOptional()
  deviceId?: string;

  @IsOptional()
  client?: string;

  @IsOptional()
  nationalId?: string;

  @IsOptional()
  birthDate?: string;

  @IsOptional()
  licenseNumber?: string;

  @IsOptional()
  licenseType?: string;

  @IsOptional()
  licenseExpiry?: string;

  @IsOptional()
  vehicleKind?: string;

  @IsOptional()
  vehicleModel?: string;

  @IsOptional()
  manufactureYear?: number;

  @IsOptional()
  plateNumber?: string;

  @IsOptional()
  vehicleColor?: string;

  @IsOptional()
  seats?: number;
}

export class RefreshTokenRequest {
  @IsNotEmpty()
  refreshToken!: string;
}

export class SocialLoginRequest {
  @IsIn(['google', 'facebook'], {
    message: 'مزود تسجيل الدخول يجب أن يكون google أو facebook',
  })
  provider!: string;

  @IsNotEmpty()
  firebaseIdToken!: string;
}

export class SocialSendOtpRequest {
  @IsIn(['google', 'facebook'], {
    message: 'مزود تسجيل الدخول يجب أن يكون google أو facebook',
  })
  provider!: string;

  @IsNotEmpty()
  firebaseIdToken!: string;

  @IsNotEmpty()
  @Matches(/^\+?20\d{10}$/, {
    message: 'رقم الهاتف غير صالح. استخدم صيغة مصرية مثل +2010xxxxxxxx',
  })
  phone!: string;
}

export class SocialCompleteRequest {
  @IsIn(['google', 'facebook'], {
    message: 'مزود تسجيل الدخول يجب أن يكون google أو facebook',
  })
  provider!: string;

  @IsNotEmpty()
  firebaseIdToken!: string;

  @IsNotEmpty()
  @Matches(/^\+?20\d{10}$/, {
    message: 'رقم الهاتف غير صالح. استخدم صيغة مصرية مثل +2010xxxxxxxx',
  })
  phone!: string;

  @IsNotEmpty()
  @Length(4, 4)
  @Matches(/^\d{4}$/, { message: 'رمز التحقق يجب أن يكون 4 أرقام' })
  code!: string;
}

export class UpdateProfileRequest {
  @IsOptional()
  fullName?: string;

  @IsOptional()
  email?: string;

  @IsOptional()
  gender?: string;

  @IsOptional()
  avatarUrl?: string;
}

export class AdminSendOtpRequest {
  @IsNotEmpty()
  phone!: string;
}

export class AdminLoginRequest {
  @IsNotEmpty()
  phone!: string;

  @IsNotEmpty()
  code!: string;
}

export interface UserProfileDto {
  id: string;
  phone: string;
  fullName: string | null;
  email: string | null;
  gender: string | null;
  avatarUrl: string | null;
  ratingAverage: number;
  ratingCount: number;
  userType: string;
}

export interface AuthTokensDto {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
}

export interface AuthResponseDto {
  tokens: AuthTokensDto;
  user: UserProfileDto;
}

export interface SendOtpResponseDto {
  message: string;
  debugCode?: string | null;
}

export interface SocialLoginResultDto {
  requiresPhoneVerification: boolean;
  provider: string;
  auth: AuthResponseDto | null;
  displayName?: string | null;
  email?: string | null;
  photoUrl?: string | null;
}

export interface AdminIdentityDto {
  id: string;
  phone: string;
  fullName: string | null;
  email: string | null;
  avatarUrl: string | null;
  role: string;
}

export interface AdminLoginResponse {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  admin: AdminIdentityDto;
}
