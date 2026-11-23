import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

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

  @IsOptional()
  @IsString()
  @MaxLength(16)
  platform?: string;
}

export class ResetPasswordRequest {
  @IsNotEmpty()
  phone!: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword!: string;

  @IsOptional()
  @ValidateIf((_, value) => value != null && value !== '')
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'رمز التحقق يجب أن يكون 6 أرقام' })
  code?: string;

  @IsOptional()
  @IsString()
  firebaseIdToken?: string;

  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @IsString()
  deviceId?: string;
}

export class VerifyOtpRequest {
  @IsNotEmpty()
  phone!: string;

  @IsOptional()
  @ValidateIf((_, value) => value != null && value !== '')
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'رمز التحقق يجب أن يكون 6 أرقام' })
  code?: string;

  @IsOptional()
  @IsString()
  firebaseIdToken?: string;

  @IsOptional()
  purpose: string = 'login';

  @IsOptional()
  @IsString()
  client?: string;

  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsString()
  platform?: string;
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

  @IsOptional()
  @ValidateIf((_, value) => value != null && value !== '')
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'رمز التحقق يجب أن يكون 6 أرقام' })
  code?: string;

  @IsOptional()
  @IsString()
  firebaseIdToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  platform?: string;

  @IsOptional()
  @ValidateIf((_, value) => value != null && String(value).trim() !== '')
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^(?=.*[A-Za-z\u0600-\u06FF])(?=.*\d).{8,128}$/, {
    message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل وتحتوي على حرف ورقم',
  })
  password?: string;

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

export class PasswordLoginRequest {
  @IsNotEmpty()
  @Matches(/^\+?20\d{10}$/, {
    message: 'رقم الهاتف غير صالح. استخدم صيغة مصرية مثل +2010xxxxxxxx',
  })
  phone!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  platform?: string;

  @IsOptional()
  @IsString()
  client?: string;
}

export class ChangePasswordRequest {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  currentPassword?: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^(?=.*[A-Za-z\u0600-\u06FF])(?=.*\d).{8,128}$/, {
    message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل وتحتوي على حرف ورقم',
  })
  newPassword!: string;
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

  @IsOptional()
  @IsString()
  phoneFirebaseIdToken?: string;

  @IsNotEmpty()
  @Matches(/^\+?20\d{10}$/, {
    message: 'رقم الهاتف غير صالح. استخدم صيغة مصرية مثل +2010xxxxxxxx',
  })
  phone!: string;

  @IsOptional()
  @ValidateIf((_, value) => value != null && value !== '')
  @Length(4, 4)
  @Matches(/^\d{4}$/, { message: 'رمز التحقق يجب أن يكون 4 أرقام' })
  code?: string;
}

export class ChangePhoneRequest {
  @IsNotEmpty()
  firebaseIdToken!: string;

  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsString()
  platform?: string;
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
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  phone!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
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
  hasPassword: boolean;
  phoneVerified: boolean;
}

export interface AuthTokensDto {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  sessionId: string;
}

export interface AuthResponseDto {
  tokens: AuthTokensDto;
  user: UserProfileDto;
}

export interface SendOtpResponseDto {
  message: string;
  testCode?: string;
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
