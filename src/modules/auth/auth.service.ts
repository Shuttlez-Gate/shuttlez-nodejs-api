import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthRateLimiter } from './auth-rate-limiter';
import { PhoneAccountService } from './phone-account.service';
import { isAdminPasswordShape, passwordMatches } from './password.util';
import { findStoredRefreshToken, hashRefreshToken } from './refresh-token.util';
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
  ChangePhoneRequest,
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
    private readonly phoneAccounts: PhoneAccountService,
    private readonly rateLimit: AuthRateLimiter,
  ) {}

  async sendOtp(request: SendOtpRequest): Promise<SendOtpResponseDto> {
    const purpose = parsePurpose(request.purpose);
    const phone = normalizePhone(request.phone);
    this.rateLimit.hit(`send-otp:${phone}`, 5, 15 * 60_000);

    if (purpose === OtpPurpose.Login) {
      const user = await this.prisma.user.findFirst({
        where: { phone, isDeleted: false },
      });
      if (!user) {
        throw new AppException(
          'رقم جوال غير مسجل بالنظام، يمكنك تسجيل مستخدم جديد',
        );
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

    if (this.webChromeTest(request.platform)) {
      const testCode = await this.otp.issueWebTestCode(phone, purpose);
      return {
        message: 'رمز اختبار كروم. اكتبه في الشاشة',
        testCode,
      };
    }

    const result = await this.otp.sendOtp(phone, purpose);
    return { message: result.message };
  }

  async verifyOtp(request: VerifyOtpRequest, ip?: string): Promise<AuthResponseDto> {
    const phoneKey = normalizePhone(request.phone);
    this.rateLimit.hit(`verify-otp:${phoneKey}`, 8, 15 * 60_000);
    if (this.webChromeTest(request.platform)) {
      return this.verifyWebChromeTest(request, phoneKey, ip);
    }
    const identity = await this.requirePhoneIdentity(
      request.firebaseIdToken,
      request.phone,
    );
    const linked = await this.phoneAccounts.resolveExisting(identity);
    if (!linked) {
      throw new AppException(
        'رقم جوال غير مسجل بالنظام، يمكنك تسجيل مستخدم جديد',
      );
    }

    const user = await this.prisma.user.findFirst({
      where: { id: linked.id, isDeleted: false },
    });
    if (!user) {
      throw new AppException(
        'رقم جوال غير مسجل بالنظام، يمكنك تسجيل مستخدم جديد',
      );
    }
    if (parsePurpose(request.purpose) === OtpPurpose.Login) {
      await this.ensureCaptainCanLogin(user, request.client);
    }
    await this.phoneAccounts.bindUidIfMissing(linked, identity.uid);
    const tokens = await this.issueTokens(user, {
      ip,
      deviceId: request.deviceId,
      platform: request.platform,
    });
    this.firebase.consumePhoneToken(request.firebaseIdToken!.trim(), identity.expiresAt);
    return { tokens, user: toProfileDto(user) };
  }

  async register(request: RegisterRequest, ip?: string): Promise<AuthResponseDto> {
    this.rateLimit.hit(`register:${normalizePhone(request.phone)}`, 5, 15 * 60_000);
    const webTest = this.webChromeTest(request.platform);
    let phone: string;
    let firebaseUid: string | null = null;
    let firebaseExpiresAt = 0;
    if (webTest) {
      phone = normalizePhone(request.phone);
      const code = request.code?.trim() ?? '';
      const accepted =
        /^\d{6}$/.test(code) &&
        (await this.otp.verifyOtp(phone, code, OtpPurpose.Register));
      if (!accepted) {
        throw new UnauthorizedAppException('رمز التحقق غير صحيح');
      }
      const existingPhone = await this.prisma.user.findFirst({
        where: { phone, isDeleted: false },
        select: { id: true },
      });
      if (existingPhone) {
        throw new AppException('رقم الهاتف مسجل بالفعل', 409, 'PHONE_ALREADY_REGISTERED');
      }
    } else {
      const identity = await this.requirePhoneIdentity(
        request.firebaseIdToken,
        request.phone,
      );
      phone = identity.phone;
      const existing = await this.phoneAccounts.resolveExisting(identity);
      if (existing) {
        throw new AppException('رقم الهاتف مسجل بالفعل');
      }
      firebaseUid = identity.uid;
      firebaseExpiresAt = identity.expiresAt;
    }

    const asDriver = isDriverRegistration(request.userType, request.client);
    const userId = newId();
    const now = utcNow();

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: userId,
            phone,
            fullName: request.fullName,
            email: request.email,
            gender: parseGender(request.gender),
            userType: asDriver ? UserType.Driver : UserType.Passenger,
            firebasePhoneUid: firebaseUid,
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
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw new AppException('رقم الهاتف مسجل بالفعل', 409, 'PHONE_ALREADY_REGISTERED');
      }
      throw error;
    }

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const tokens = await this.issueTokens(user, {
      ip,
      deviceId: request.deviceId,
      platform: request.platform,
    });
    if (!webTest) {
      this.firebase.consumePhoneToken(request.firebaseIdToken!.trim(), firebaseExpiresAt);
    }
    return { tokens, user: toProfileDto(user) };
  }

  async refreshToken(refreshToken: string, ip?: string): Promise<AuthTokensDto> {
    this.rateLimit.hit(`refresh:${hashRefreshToken(refreshToken).slice(0, 16)}`, 30, 15 * 60_000);
    const token = await findStoredRefreshToken(this.prisma, refreshToken);
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
        data: { revokedAt: now, replacedByToken: hashRefreshToken(replacement) },
      }),
      this.prisma.refreshToken.create({
        data: {
          id: newIdValue,
          userId: user.id,
          token: hashRefreshToken(replacement),
          expiresAt,
          createdByIp: ip,
          deviceId: token.deviceId,
          platform: token.platform,
          ...baseFields(now),
        },
      }),
    ]);

    return {
      accessToken: this.jwt.generateAccessToken(user, newIdValue),
      refreshToken: replacement,
      accessTokenExpiresAt: this.jwt.accessTokenExpiresAt(now),
      refreshTokenExpiresAt: expiresAt,
      sessionId: newIdValue,
    };
  }

  async logout(refreshToken: string): Promise<void> {
    const token = await findStoredRefreshToken(this.prisma, refreshToken);
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
    const tokens = await this.issueTokens(linkedUser, { ip });
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

    this.rateLimit.hit(`social-otp:${normalizePhone(request.phone)}`, 5, 15 * 60_000);
    const result = await this.otp.sendOtp(request.phone, OtpPurpose.SocialLink);
    return { message: result.message };
  }

  async socialComplete(
    request: SocialCompleteRequest,
    ip?: string,
  ): Promise<AuthResponseDto> {
    const identity = await this.firebase.verify(
      request.provider,
      request.firebaseIdToken,
    );
    const phoneIdentity = await this.requirePhoneIdentity(
      request.phoneFirebaseIdToken,
      request.phone,
    );
    const phone = phoneIdentity.phone;
    const linkedUser = await this.findLinkedUser(
      identity.provider,
      identity.providerUserId,
    );
    const existing = await this.phoneAccounts.resolveExisting(phoneIdentity);
    ensureProviderNotLinkedToAnotherUser(linkedUser, existing);

    let user;
    if (!existing) {
      const userId = newId();
      const now = utcNow();
      try {
        await this.prisma.$transaction([
          this.prisma.user.create({
            data: {
              id: userId,
              phone,
              fullName: identity.displayName?.trim() || phone,
              email: identity.email?.trim() || null,
              avatarUrl: identity.photoUrl?.trim() || null,
              userType: UserType.Passenger,
              firebasePhoneUid: phoneIdentity.uid,
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
      } catch (error) {
        if (isUniqueConflict(error)) {
          throw new AppException(
            'رقم الهاتف مسجل بالفعل',
            409,
            'PHONE_ALREADY_REGISTERED',
          );
        }
        throw error;
      }
      user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    } else {
      const current = await this.prisma.user.findFirst({
        where: { id: existing.id, isDeleted: false },
      });
      if (!current) {
        throw new NotFoundException('المستخدم غير موجود');
      }
      ensureUserIsActive(current);
      await this.phoneAccounts.bindUidIfMissing(existing, phoneIdentity.uid);
      await this.prisma.user.update({
        where: { id: current.id },
        data: {
          fullName: current.fullName || identity.displayName?.trim() || current.fullName,
          email: current.email || identity.email?.trim() || current.email,
          avatarUrl: current.avatarUrl || identity.photoUrl?.trim() || current.avatarUrl,
          googleProviderId:
            identity.provider === SocialAuthProvider.Google
              ? identity.providerUserId
              : current.googleProviderId,
          facebookProviderId:
            identity.provider === SocialAuthProvider.Facebook
              ? identity.providerUserId
              : current.facebookProviderId,
        },
      });
      user = await this.prisma.user.findUniqueOrThrow({ where: { id: current.id } });
    }

    const tokens = await this.issueTokens(user, { ip });
    this.firebase.consumePhoneToken(
      request.phoneFirebaseIdToken!.trim(),
      phoneIdentity.expiresAt,
    );
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

  async deleteMe() {
    const userId = this.currentUser.requireUserId();
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isDeleted: false },
    });
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }
    const now = utcNow();
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, updatedAt: now },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          isDeleted: true,
          isActive: false,
          phone: `del_${user.id.replaceAll('-', '')}`.slice(0, 36),
          googleProviderId: null,
          facebookProviderId: null,
          firebasePhoneUid: null,
          fcmToken: null,
          updatedAt: now,
        },
      }),
    ]);
  }

  async sendAdminOtp(phoneRaw: string): Promise<SendOtpResponseDto> {
    const phone = normalizePhone(phoneRaw);
    this.rateLimit.hit(`admin-otp:${phone}`, 5, 15 * 60_000);
    return { message: 'دخول لوحة التحكم يتم برقم الهاتف وكلمة المرور' };
  }

  async adminLogin(
    request: AdminLoginRequest,
    ip?: string,
  ): Promise<AdminLoginResponse> {
    const phone = normalizePhone(request.phone);
    this.rateLimit.hit(`admin-login:${phone}`, 8, 15 * 60_000);
    if (ip) this.rateLimit.hit(`admin-login-ip:${ip}`, 20, 15 * 60_000);

    const password = request.password ?? '';
    const shaped = isAdminPasswordShape(password);
    const user = await this.prisma.user.findFirst({
      where: { phone, isDeleted: false },
    });
    const matches = await passwordMatches(password, user?.passwordHash);
    if (
      !shaped ||
      !user ||
      user.userType !== UserType.Admin ||
      !user.isActive ||
      !matches
    ) {
      throw new UnauthorizedAppException('بيانات الدخول غير صحيحة');
    }

    const tokens = await this.issueTokens(user, { ip, platform: 'admin' });
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
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

  async changePhone(request: ChangePhoneRequest, ip?: string): Promise<AuthResponseDto> {
    const userId = this.currentUser.requireUserId();
    this.rateLimit.hit(`change-phone:${userId}`, 5, 15 * 60_000);
    const identity = await this.requirePhoneIdentity(request.firebaseIdToken);
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isDeleted: false },
    });
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    ensureUserIsActive(user);

    if (user.phone === identity.phone) {
      await this.phoneAccounts.bindUidIfMissing(
        {
          id: user.id,
          phone: user.phone,
          firebasePhoneUid: user.firebasePhoneUid,
        },
        identity.uid,
      );
      const tokens = await this.issueTokens(user, {
        ip,
        deviceId: request.deviceId,
        platform: request.platform,
      });
      this.firebase.consumePhoneToken(request.firebaseIdToken.trim(), identity.expiresAt);
      return { tokens, user: toProfileDto(user) };
    }

    const phoneOwner = await this.prisma.user.findFirst({
      where: { phone: identity.phone, isDeleted: false, NOT: { id: user.id } },
      select: { id: true },
    });
    if (phoneOwner) {
      throw new AppException(
        'رقم الهاتف مرتبط بحساب آخر ولن يتم دمج الحسابات',
        409,
        'PHONE_IN_USE',
      );
    }
    const uidOwner = await this.prisma.user.findFirst({
      where: { firebasePhoneUid: identity.uid, isDeleted: false, NOT: { id: user.id } },
      select: { id: true },
    });
    if (uidOwner) {
      throw new AppException(
        'حساب Firebase مرتبط بحساب آخر',
        409,
        'FIREBASE_UID_CONFLICT',
      );
    }

    const now = utcNow();
    try {
      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: user.id },
          data: {
            phone: identity.phone,
            firebasePhoneUid: identity.uid,
            updatedAt: now,
          },
        }),
        this.prisma.refreshToken.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: now, updatedAt: now },
        }),
      ]);
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw new AppException(
          'رقم الهاتف مرتبط بحساب آخر ولن يتم دمج الحسابات',
          409,
          'PHONE_IN_USE',
        );
      }
      throw error;
    }

    const updated = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const tokens = await this.issueTokens(updated, {
      ip,
      deviceId: request.deviceId,
      platform: request.platform,
    });
    this.firebase.consumePhoneToken(request.firebaseIdToken.trim(), identity.expiresAt);
    return { tokens, user: toProfileDto(updated) };
  }

  async listSessions() {
    const userId = this.currentUser.requireUserId();
    const rows = await this.prisma.refreshToken.findMany({
      where: {
        userId,
        isDeleted: false,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    const current = this.currentUser.sessionId;
    return rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      platform: row.platform,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      current: row.id === current,
    }));
  }

  async revokeSession(sessionId: string): Promise<void> {
    const userId = this.currentUser.requireUserId();
    const row = await this.prisma.refreshToken.findFirst({
      where: { id: sessionId, userId, isDeleted: false },
    });
    if (!row) throw new NotFoundException('الجلسة غير موجودة');
    if (row.revokedAt == null) {
      await this.prisma.refreshToken.update({
        where: { id: row.id },
        data: { revokedAt: utcNow() },
      });
    }
  }

  async revokeAllSessions(): Promise<void> {
    const userId = this.currentUser.requireUserId();
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: utcNow(), updatedAt: utcNow() },
    });
  }

  private webChromeTest(platform?: string): boolean {
    return process.env.NODE_ENV !== 'production' && platform === 'web';
  }

  private async verifyWebChromeTest(
    request: VerifyOtpRequest,
    phoneKey: string,
    ip?: string,
  ): Promise<AuthResponseDto> {
    const purpose = parsePurpose(request.purpose);
    const code = request.code?.trim() ?? '';
    const accepted =
      /^\d{6}$/.test(code) && (await this.otp.verifyOtp(phoneKey, code, purpose));
    if (!accepted) {
      throw new UnauthorizedAppException('رمز التحقق غير صحيح');
    }
    const user = await this.prisma.user.findFirst({
      where: { phone: phoneKey, isDeleted: false },
    });
    if (!user) {
      throw new AppException(
        'رقم جوال غير مسجل بالنظام، يمكنك تسجيل مستخدم جديد',
      );
    }
    if (purpose === OtpPurpose.Login) {
      await this.ensureCaptainCanLogin(user, request.client);
    }
    const tokens = await this.issueTokens(user, {
      ip,
      deviceId: request.deviceId,
      platform: request.platform,
    });
    return { tokens, user: toProfileDto(user) };
  }

  private async requirePhoneIdentity(token: string | undefined, claimedPhone?: string) {
    if (!token?.trim()) {
      throw new UnauthorizedAppException(
        'يلزم التحقق من رقم الهاتف عبر Firebase',
        'FIREBASE_PHONE_REQUIRED',
      );
    }
    const identity = await this.firebase.verifyPhone(token.trim());
    if (claimedPhone?.trim() && normalizePhone(claimedPhone) !== identity.phone) {
      throw new UnauthorizedAppException(
        'رقم الهاتف لا يطابق رمز Firebase',
        'PHONE_CLAIM_MISMATCH',
      );
    }
    return identity;
  }

  private async issueTokens(
    user: { id: string; phone: string; userType: number },
    context: { ip?: string; deviceId?: string; platform?: string } = {},
  ): Promise<AuthTokensDto> {
    const now = utcNow();
    const refreshTokenValue = this.jwt.generateRefreshToken();
    const sessionId = newId();
    const expiresAt = addDays(now, 30);
    await this.prisma.refreshToken.create({
      data: {
        id: sessionId,
        userId: user.id,
        token: hashRefreshToken(refreshTokenValue),
        expiresAt,
        createdByIp: context.ip,
        deviceId: blankToNull(context.deviceId),
        platform: blankToNull(context.platform),
        ...baseFields(now),
      },
    });
    return {
      accessToken: this.jwt.generateAccessToken(user, sessionId),
      refreshToken: refreshTokenValue,
      accessTokenExpiresAt: this.jwt.accessTokenExpiresAt(now),
      refreshTokenExpiresAt: expiresAt,
      sessionId,
    };
  }

  private async ensureCaptainCanLogin(
    user: { id: string; userType: number; isActive: boolean },
    client?: string,
  ): Promise<void> {
    if (!isDriverClient(client)) {
      return;
    }
    if (!user.isActive) {
      throw new AppException('تم تعطيل هذا الحساب. تواصل مع الإدارة');
    }

    const driver = await this.prisma.driver.findFirst({
      where: { userId: user.id, isDeleted: false },
    });

    if (!driver && user.userType !== UserType.Driver) {
      throw new AppException(
        'هذا الحساب غير مصرح له بدخول تطبيق الكابتن. الدخول للكباتن المعتمدين فقط',
      );
    }

    // Auto-sync user.userType if driver record exists
    if (driver && user.userType !== UserType.Driver) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { userType: UserType.Driver, updatedAt: utcNow() },
      });
      user.userType = UserType.Driver;
    }

    if (!driver) {
      throw new AppException(
        'حساب الكابتن غير مكتمل أو غير مسجل. يرجى تسجيل حساب كابتن جديد',
      );
    }

    if (driver.verificationStatus === DriverVerificationStatus.Rejected) {
      throw new AppException(
        'تم رفض طلب انضمام الكابتن. تواصل مع الإدارة لمزيد من التفاصيل',
      );
    }

    if (driver.verificationStatus === DriverVerificationStatus.Approved && !driver.isActive) {
      throw new AppException(
        'حساب الكابتن معطل حالياً من قِبل الإدارة. تواصل مع الدعم الفني',
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

export function isDriverRegistration(userType?: string, client?: string): boolean {
  if (userType?.trim().toLowerCase() === 'driver') {
    return true;
  }
  return isDriverClient(client);
}

function isUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  );
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
