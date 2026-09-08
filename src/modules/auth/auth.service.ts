import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import {
  AppException,
  ForbiddenAppException,
  NotFoundException,
  UnauthorizedAppException,
} from '../../common/exceptions/app.exception';
import {
  DriverVerificationStatus,
  OtpPurpose,
  UserType,
} from '../../common/enums';
import { normalizePhone } from '../../common/utils/phone-normalizer';
import { addDays, newId, utcNow } from '../../common/utils/date.util';
import {
  baseFields,
  driverDefaults,
  userDefaults,
  walletDefaults,
} from '../../common/utils/entity-defaults';
import { CurrentUserService } from '../../common/current-user.service';
import { JwtTokenService } from './jwt-token.service';
import { OtpService } from './otp.service';
import { FirebaseTokenVerifier } from '../../integrations/firebase/firebase-token.verifier';
import {
  AdminIdentityDto,
  AdminLoginRequest,
  AdminLoginResponse,
  AuthResponseDto,
  AuthTokensDto,
  RegisterRequest,
  SendOtpRequest,
  SendOtpResponseDto,
  SocialCompleteRequest,
  SocialLoginRequest,
  SocialLoginResultDto,
  SocialSendOtpRequest,
  UpdateProfileRequest,
  VerifyOtpRequest,
} from './auth.dto';
import {
  normalizeSocialProvider,
  parseGender,
  parsePurpose,
  SocialAuthProvider,
  toProfileDto,
} from './auth.mapper';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly jwt: JwtTokenService,
    private readonly currentUser: CurrentUserService,
    private readonly firebase: FirebaseTokenVerifier,
  ) {}

  async sendOtp(request: SendOtpRequest): Promise<SendOtpResponseDto> {
    const purpose = parsePurpose(request.purpose);
    const phone = normalizePhone(request.phone);

    if (purpose === OtpPurpose.Login) {
      const user = await this.prisma.user.findFirst({
        where: { phone, isDeleted: false },
      });
      if (!user) {
        throw new AppException('رقم الهاتف غير مسجل. أنشئ حساباً أولاً');
      }
      await this.ensureCaptainCanLogin(user, request.client);
    }

    if (purpose === OtpPurpose.Register) {
      const exists = await this.prisma.user.findFirst({
        where: { phone, isDeleted: false },
      });
      if (exists) {
        throw new AppException('رقم الهاتف مسجل بالفعل. سجّل الدخول بدلاً من ذلك');
      }
    }

    const result = await this.otp.sendOtp(phone, purpose);
    return { message: result.message, debugCode: result.debugCode };
  }

  async verifyOtp(request: VerifyOtpRequest, ip?: string): Promise<AuthResponseDto> {
    const purpose = parsePurpose(request.purpose);
    const phone = normalizePhone(request.phone);
    const valid = await this.otp.verifyOtp(phone, request.code, purpose);
    if (!valid) {
      throw new UnauthorizedAppException('رمز التحقق غير صحيح أو منتهي الصلاحية');
    }

    const user = await this.prisma.user.findFirst({
      where: { phone, isDeleted: false },
    });
    if (!user) {
      throw new AppException('رقم الهاتف غير مسجل. أنشئ حساباً أولاً');
    }

    if (purpose === OtpPurpose.Login) {
      await this.ensureCaptainCanLogin(user, request.client);
    }

    const tokens = await this.issueTokens(user, ip);
    return { tokens, user: toProfileDto(user) };
  }

  async register(request: RegisterRequest, ip?: string): Promise<AuthResponseDto> {
    const phone = normalizePhone(request.phone);
    const valid = await this.otp.verifyOtp(phone, request.code, OtpPurpose.Register);
    if (!valid) {
      throw new UnauthorizedAppException('رمز التحقق غير صحيح أو منتهي الصلاحية');
    }

    const existing = await this.prisma.user.findFirst({
      where: { phone, isDeleted: false },
    });
    if (existing) {
      throw new AppException('رقم الهاتف مسجل بالفعل');
    }

    const asDriver = isDriverRegistration(
      request.userType,
      request.deviceId,
      request.client,
    );
    const userId = newId();
    const now = utcNow();

    await this.prisma.$transaction(async (tx) => {
      await tx.user.create({
        data: {
          id: userId,
          phone,
          fullName: request.fullName,
          email: request.email,
          gender: parseGender(request.gender),
          userType: asDriver ? UserType.Driver : UserType.Passenger,
          ...userDefaults(now),
        },
      });
      await tx.wallet.create({
        data: { id: newId(), userId, ...walletDefaults(now) },
      });
      if (asDriver) {
        await tx.driver.create({
          data: {
            id: newId(),
            userId,
            verificationStatus: DriverVerificationStatus.Pending,
            nationalId: blankToNull(request.nationalId),
            birthDate: parseDateOnly(request.birthDate),
            licenseNumber: blankToNull(request.licenseNumber),
            licenseType: blankToNull(request.licenseType),
            licenseExpiry: parseDateOnly(request.licenseExpiry),
            vehicleKind: blankToNull(request.vehicleKind),
            vehicleModelName: blankToNull(request.vehicleModel),
            manufactureYear: request.manufactureYear ?? null,
            plateNumber: blankToNull(request.plateNumber),
            vehicleColor: blankToNull(request.vehicleColor),
            seats: request.seats ?? null,
            ...driverDefaults(now),
            isActive: false,
          },
        });
      }
    });

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const tokens = await this.issueTokens(user, ip);
    return { tokens, user: toProfileDto(user) };
  }

  async refreshToken(refreshToken: string, ip?: string): Promise<AuthTokensDto> {
    const token = await this.prisma.refreshToken.findFirst({
      where: { token: refreshToken },
    });
    if (!token) {
      throw new UnauthorizedAppException('Refresh token غير صالح');
    }
    if (!isRefreshActive(token)) {
      throw new UnauthorizedAppException('Refresh token منتهي أو ملغي');
    }

    const user = await this.prisma.user.findFirst({
      where: { id: token.userId, isDeleted: false },
    });
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }

    const now = utcNow();
    const replacement = this.jwt.generateRefreshToken();
    const newIdValue = newId();
    const expiresAt = addDays(now, 30);

    await this.prisma.$transaction([
      this.prisma.refreshToken.update({
        where: { id: token.id },
        data: { revokedAt: now, replacedByToken: replacement },
      }),
      this.prisma.refreshToken.create({
        data: {
          id: newIdValue,
          userId: user.id,
          token: replacement,
          expiresAt,
          createdByIp: ip,
          ...baseFields(now),
        },
      }),
    ]);

    return {
      accessToken: this.jwt.generateAccessToken(user),
      refreshToken: replacement,
      accessTokenExpiresAt: this.jwt.accessTokenExpiresAt(now),
      refreshTokenExpiresAt: expiresAt,
    };
  }

  async logout(refreshToken: string): Promise<void> {
    const token = await this.prisma.refreshToken.findFirst({
      where: { token: refreshToken },
    });
    if (token && isRefreshActive(token)) {
      await this.prisma.refreshToken.update({
        where: { id: token.id },
        data: { revokedAt: utcNow() },
      });
    }
  }

  async socialLogin(
    request: SocialLoginRequest,
    ip?: string,
  ): Promise<SocialLoginResultDto> {
    const identity = await this.firebase.verify(
      request.provider,
      request.firebaseIdToken,
    );
    const linkedUser = await this.findLinkedUser(
      identity.provider,
      identity.providerUserId,
    );

    if (!linkedUser) {
      return {
        requiresPhoneVerification: true,
        provider: identity.provider,
        auth: null,
        displayName: identity.displayName,
        email: identity.email,
        photoUrl: identity.photoUrl,
      };
    }

    ensureUserIsActive(linkedUser);
    const tokens = await this.issueTokens(linkedUser, ip);
    return {
      requiresPhoneVerification: false,
      provider: identity.provider,
      auth: { tokens, user: toProfileDto(linkedUser) },
    };
  }

  async socialSendOtp(request: SocialSendOtpRequest): Promise<SendOtpResponseDto> {
    const identity = await this.firebase.verify(
      request.provider,
      request.firebaseIdToken,
    );
    const linkedUser = await this.findLinkedUser(
      identity.provider,
      identity.providerUserId,
    );
    if (linkedUser) {
      ensureUserIsActive(linkedUser);
      throw new AppException(
        'هذا الحساب الاجتماعي مرتبط بالفعل ويمكنك تسجيل الدخول مباشرة',
        409,
        'ACCOUNT_ALREADY_LINKED',
      );
    }

    const result = await this.otp.sendOtp(request.phone, OtpPurpose.SocialLink);
    return { message: result.message, debugCode: result.debugCode };
  }

  async socialComplete(
    request: SocialCompleteRequest,
    ip?: string,
  ): Promise<AuthResponseDto> {
    const identity = await this.firebase.verify(
      request.provider,
      request.firebaseIdToken,
    );
    const valid = await this.otp.verifyOtp(
      request.phone,
      request.code,
      OtpPurpose.SocialLink,
    );
    if (!valid) {
      throw new UnauthorizedAppException(
        'رمز التحقق غير صحيح أو منتهي الصلاحية',
        'OTP_INVALID',
      );
    }

    const phone = normalizePhone(request.phone);
    const linkedUser = await this.findLinkedUser(
      identity.provider,
      identity.providerUserId,
    );
    let user = await this.prisma.user.findFirst({
      where: { phone, isDeleted: false },
    });

    ensureProviderNotLinkedToAnotherUser(linkedUser, user);

    if (!user) {
      const userId = newId();
      const now = utcNow();
      await this.prisma.$transaction([
        this.prisma.user.create({
          data: {
            id: userId,
            phone,
            fullName: identity.displayName?.trim() || phone,
            email: identity.email?.trim() || null,
            avatarUrl: identity.photoUrl?.trim() || null,
            userType: UserType.Passenger,
            googleProviderId:
              identity.provider === SocialAuthProvider.Google
                ? identity.providerUserId
                : undefined,
            facebookProviderId:
              identity.provider === SocialAuthProvider.Facebook
                ? identity.providerUserId
                : undefined,
            ...userDefaults(now),
          },
        }),
        this.prisma.wallet.create({
          data: { id: newId(), userId, ...walletDefaults(now) },
        }),
      ]);
      user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    } else {
      ensureUserIsActive(user);
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          fullName: user.fullName || identity.displayName?.trim() || user.fullName,
          email: user.email || identity.email?.trim() || user.email,
          avatarUrl: user.avatarUrl || identity.photoUrl?.trim() || user.avatarUrl,
          googleProviderId:
            identity.provider === SocialAuthProvider.Google
              ? identity.providerUserId
              : user.googleProviderId,
          facebookProviderId:
            identity.provider === SocialAuthProvider.Facebook
              ? identity.providerUserId
              : user.facebookProviderId,
        },
      });
      user = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    }

    const tokens = await this.issueTokens(user, ip);
    return { tokens, user: toProfileDto(user) };
  }

  async getMe() {
    const userId = this.currentUser.requireUserId();
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isDeleted: false },
    });
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }
    return toProfileDto(user);
  }

  async updateMe(request: UpdateProfileRequest) {
    const userId = this.currentUser.requireUserId();
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isDeleted: false },
    });
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }

    const data: Prisma.UserUpdateInput = { updatedAt: utcNow() };
    if (request.fullName && request.fullName.trim()) {
      data.fullName = request.fullName.trim();
    }
    if (request.email !== undefined) {
      data.email = request.email.trim();
    }
    if (request.gender !== undefined) {
      data.gender = parseGender(request.gender);
    }
    if (request.avatarUrl !== undefined) {
      data.avatarUrl = request.avatarUrl;
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data,
    });
    return toProfileDto(updated);
  }

  async sendAdminOtp(phoneRaw: string): Promise<SendOtpResponseDto> {
    const phone = normalizePhone(phoneRaw);
    const isAdmin = await this.prisma.user.findFirst({
      where: {
        phone,
        isDeleted: false,
        isActive: true,
        userType: UserType.Admin,
      },
    });
    if (!isAdmin) {
      throw new UnauthorizedAppException(
        'هذا الرقم غير مصرّح له بالدخول للوحة التحكم',
      );
    }
    const result = await this.otp.sendOtp(phone, OtpPurpose.Login);
    return { message: result.message, debugCode: result.debugCode };
  }

  async adminLogin(
    request: AdminLoginRequest,
    ip?: string,
  ): Promise<AdminLoginResponse> {
    const phone = normalizePhone(request.phone);
    const user = await this.prisma.user.findFirst({
      where: { phone, isDeleted: false },
    });
    if (!user) {
      throw new UnauthorizedAppException('بيانات الدخول غير صحيحة');
    }
    if (user.userType !== UserType.Admin) {
      throw new ForbiddenAppException('هذا الحساب ليس حساب مسؤول');
    }
    if (!user.isActive) {
      throw new ForbiddenAppException('الحساب موقوف. راجع مسؤول النظام');
    }
    const valid = await this.otp.verifyOtp(phone, request.code, OtpPurpose.Login);
    if (!valid) {
      throw new UnauthorizedAppException('رمز التحقق غير صحيح أو منتهي');
    }

    const now = utcNow();
    const refreshValue = this.jwt.generateRefreshToken();
    const expiresAt = addDays(now, 30);
    await this.prisma.refreshToken.create({
      data: {
        id: newId(),
        userId: user.id,
        token: refreshValue,
        expiresAt,
        createdByIp: ip,
        ...baseFields(now),
      },
    });

    return {
      accessToken: this.jwt.generateAccessToken(user),
      refreshToken: refreshValue,
      accessTokenExpiresAt: this.jwt.accessTokenExpiresAt(now),
      refreshTokenExpiresAt: expiresAt,
      admin: toAdminIdentity(user),
    };
  }

  async adminMe(): Promise<AdminIdentityDto> {
    const userId = this.currentUser.requireUserId('يجب تسجيل الدخول');
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isDeleted: false },
    });
    if (!user) {
      throw new NotFoundException('الحساب غير موجود');
    }
    if (user.userType !== UserType.Admin) {
      throw new ForbiddenAppException('هذا الحساب ليس حساب مسؤول');
    }
    return toAdminIdentity(user);
  }

  private async issueTokens(
    user: { id: string; phone: string; userType: number },
    ip?: string,
  ): Promise<AuthTokensDto> {
    const now = utcNow();
    const refreshTokenValue = this.jwt.generateRefreshToken();
    const expiresAt = addDays(now, 30);
    await this.prisma.refreshToken.create({
      data: {
        id: newId(),
        userId: user.id,
        token: refreshTokenValue,
        expiresAt,
        createdByIp: ip,
        ...baseFields(now),
      },
    });
    return {
      accessToken: this.jwt.generateAccessToken(user),
      refreshToken: refreshTokenValue,
      accessTokenExpiresAt: this.jwt.accessTokenExpiresAt(now),
      refreshTokenExpiresAt: expiresAt,
    };
  }

  private async ensureCaptainCanLogin(
    user: { id: string; userType: number; isActive: boolean },
    client?: string,
  ): Promise<void> {
    if (!isDriverClient(client)) {
      return;
    }
    if (user.userType !== UserType.Driver || !user.isActive) {
      throw new AppException(
        'هذا الحساب غير مصرح له بدخول تطبيق الكابتن. الدخول للكباتن المعتمدين فقط',
      );
    }
    const hasActiveDriver = await this.prisma.driver.findFirst({
      where: { userId: user.id, isDeleted: false, isActive: true },
    });
    if (!hasActiveDriver) {
      throw new AppException(
        'حساب الكابتن غير مكتمل أو غير مفعّل. تواصل مع الإدارة',
      );
    }
  }

  private async findLinkedUser(provider: string, providerUserId: string) {
    const normalized = normalizeSocialProvider(provider);
    if (normalized === SocialAuthProvider.Google) {
      return this.prisma.user.findFirst({
        where: { googleProviderId: providerUserId, isDeleted: false },
      });
    }
    return this.prisma.user.findFirst({
      where: { facebookProviderId: providerUserId, isDeleted: false },
    });
  }
}

function isDriverClient(client?: string): boolean {
  const value = client?.trim().toLowerCase();
  return value === 'driver' || value === 'captain';
}

function isDriverRegistration(
  userType?: string,
  deviceId?: string,
  client?: string,
): boolean {
  if (userType?.trim().toLowerCase() === 'driver') {
    return true;
  }
  if (isDriverClient(client)) {
    return true;
  }
  return Boolean(deviceId && deviceId.trim());
}

function blankToNull(value?: string | null): string | null {
  if (!value || !value.trim()) {
    return null;
  }
  return value.trim();
}

function parseDateOnly(value?: string | null): Date | null {
  if (!value || !value.trim()) {
    return null;
  }
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isRefreshActive(token: {
  expiresAt: Date;
  revokedAt: Date | null;
}): boolean {
  return token.revokedAt == null && token.expiresAt > new Date();
}

function ensureUserIsActive(user: { isActive: boolean }): void {
  if (!user.isActive) {
    throw new ForbiddenAppException('هذا الحساب غير نشط', 'ACCOUNT_DISABLED');
  }
}

function ensureProviderNotLinkedToAnotherUser(
  linkedUser: { id: string } | null,
  targetUser: { id: string } | null,
): void {
  if (!linkedUser) {
    return;
  }
  if (!targetUser || linkedUser.id !== targetUser.id) {
    throw new AppException(
      'هذا الحساب الاجتماعي مرتبط بالفعل بحساب آخر',
      409,
      'FIREBASE_UID_ALREADY_LINKED',
    );
  }
}

function toAdminIdentity(user: {
  id: string;
  phone: string;
  fullName: string | null;
  email: string | null;
  avatarUrl: string | null;
  userType: number;
}): AdminIdentityDto {
  const role =
    user.userType === UserType.Admin
      ? 'Admin'
      : user.userType === UserType.Driver
        ? 'Driver'
        : 'Passenger';
  return {
    id: user.id,
    phone: user.phone,
    fullName: user.fullName,
    email: user.email,
    avatarUrl: user.avatarUrl,
    role,
  };
}
