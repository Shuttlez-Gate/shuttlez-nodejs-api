import { ForbiddenAppException, UnauthorizedAppException } from '../../common/exceptions/app.exception';
import { UserType } from '../../common/enums';
import { AdminOnlyGuard } from '../../common/guards/admin-only.guard';
import { OtpPurpose } from '../../common/enums';
import { AuthRateLimiter } from './auth-rate-limiter';
import { AuthService, isDriverRegistration } from './auth.service';
import { OtpService } from './otp.service';
import { PhoneAccountService } from './phone-account.service';
import { hashRefreshToken } from './refresh-token.util';

describe('phone authentication identity', () => {
  it('does not treat a device id as captain registration', () => {
    expect(isDriverRegistration(undefined, undefined)).toBe(false);
    expect(isDriverRegistration('passenger', undefined)).toBe(false);
    expect(isDriverRegistration('driver', undefined)).toBe(true);
    expect(isDriverRegistration(undefined, 'captain')).toBe(true);
  });

  it('stores refresh tokens as a hash, not the presented value', () => {
    const presented = 'plain-refresh-token';
    const stored = hashRefreshToken(presented);
    expect(stored).not.toBe(presented);
    expect(stored).toHaveLength(64);
  });

  it('does not return or persist a debug OTP code', async () => {
    const create = jest.fn();
    const otp = new OtpService(
      { otpRequest: { create } } as never,
      { get: () => undefined } as never,
    );
    const result = await otp.sendOtp('+201000000101', OtpPurpose.Login);
    expect(result).toEqual({
      message: expect.stringContaining('Firebase'),
    });
    expect(result).not.toHaveProperty('debugCode');
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects phone login that is not backed by a Firebase token', async () => {
    const service = new AuthService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { verifyPhone: jest.fn(), consumePhoneToken: jest.fn() } as never,
      {} as never,
      new AuthRateLimiter(),
    );
    await expect(
      service.verifyOtp({ phone: '+201000000101', purpose: 'login' }),
    ).rejects.toBeInstanceOf(UnauthorizedAppException);
    await expect(
      service.verifyOtp({ phone: '+201000000101', code: '123456', purpose: 'login' }),
    ).rejects.toMatchObject({ code: 'FIREBASE_PHONE_REQUIRED' });
  });

  it('issues a chrome test code only when the server is not in production', async () => {
    const previous = process.env.NODE_ENV;
    const issueWebTestCode = jest.fn(async () => '654321');
    const verifyOtp = jest.fn(async () => true);
    const sendOtp = jest.fn(async () => ({ message: 'firebase path' }));
    const user = {
      id: 'rider-1',
      phone: '+201000000101',
      fullName: 'Rider',
      email: null,
      gender: null,
      avatarUrl: null,
      ratingAverage: 0,
      ratingCount: 0,
      userType: UserType.Passenger,
      isActive: true,
    };
    const prisma = {
      user: { findFirst: jest.fn(async () => user) },
      refreshToken: { create: jest.fn(async () => ({})) },
    };
    const firebase = { verifyPhone: jest.fn(), consumePhoneToken: jest.fn() };
    const service = new AuthService(
      prisma as never,
      { sendOtp, issueWebTestCode, verifyOtp } as never,
      {
        generateRefreshToken: () => 'refresh-plain',
        generateAccessToken: () => 'access-plain',
        accessTokenExpiresAt: () => new Date('2026-11-01T00:00:00Z'),
      } as never,
      {} as never,
      firebase as never,
      {} as never,
      new AuthRateLimiter(),
    );

    try {
      process.env.NODE_ENV = 'development';
      const issued = await service.sendOtp({
        phone: '+201000000101',
        purpose: 'login',
        platform: 'web',
      });
      expect(issued.testCode).toBe('654321');
      expect(issueWebTestCode).toHaveBeenCalledTimes(1);
      expect(sendOtp).not.toHaveBeenCalled();

      const session = await service.verifyOtp({
        phone: '01000000101',
        code: '654321',
        purpose: 'login',
        platform: 'web',
      });
      expect(session.tokens.accessToken).toBe('access-plain');
      expect(firebase.verifyPhone).not.toHaveBeenCalled();

      process.env.NODE_ENV = 'production';
      const blocked = await service.sendOtp({
        phone: '+201000000101',
        purpose: 'login',
        platform: 'web',
      });
      expect(blocked.testCode).toBeUndefined();
      expect(sendOtp).toHaveBeenCalledTimes(1);
    } finally {
      if (previous == null) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});

describe('PhoneAccountService', () => {
  function service(users: Array<{ id: string; phone: string; firebasePhoneUid: string | null }>) {
    const prisma = {
      user: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          return (
            users.find((user) => {
              if (where.firebasePhoneUid && user.firebasePhoneUid !== where.firebasePhoneUid) {
                return false;
              }
              if (where.phone && user.phone !== where.phone) return false;
              if (where.firebasePhoneUid) return user.firebasePhoneUid === where.firebasePhoneUid;
              if (where.phone) return user.phone === where.phone;
              return false;
            }) ?? null
          );
        }),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: { firebasePhoneUid: string } }) => {
          const user = users.find((item) => item.id === where.id);
          if (user) user.firebasePhoneUid = data.firebasePhoneUid;
          return user;
        }),
      },
    };
    return new PhoneAccountService(prisma as never);
  }

  it('reuses the existing phone account and binds a new Firebase uid', async () => {
    const accounts = service([
      { id: 'user-1', phone: '+201000000101', firebasePhoneUid: null },
    ]);
    const existing = await accounts.resolveExisting({
      uid: 'firebase-1',
      phone: '+201000000101',
    });
    expect(existing?.id).toBe('user-1');
    await accounts.bindUidIfMissing(existing!, 'firebase-1');
    expect(existing?.firebasePhoneUid).toBe('firebase-1');
  });

  it('refuses to merge two existing accounts', async () => {
    const accounts = service([
      { id: 'phone-user', phone: '+201000000101', firebasePhoneUid: null },
      { id: 'uid-user', phone: '+201000000202', firebasePhoneUid: 'firebase-1' },
    ]);
    await expect(
      accounts.resolveExisting({ uid: 'firebase-1', phone: '+201000000101' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_MERGE_BLOCKED' });
  });

  it('refuses a phone that is already bound to another Firebase uid', async () => {
    const accounts = service([
      { id: 'user-1', phone: '+201000000101', firebasePhoneUid: 'firebase-old' },
    ]);
    await expect(
      accounts.resolveExisting({ uid: 'firebase-new', phone: '+201000000101' }),
    ).rejects.toMatchObject({ code: 'PHONE_UID_CONFLICT' });
  });
});

describe('AdminOnlyGuard', () => {
  function context(userId?: string) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          user: userId
            ? {
                userId,
                role: 'Admin',
                'http://schemas.microsoft.com/ws/2008/06/identity/claims/role': 'Admin',
              }
            : undefined,
        }),
      }),
    } as never;
  }

  it('authorizes from the database role, not the token claim', async () => {
    const prisma = {
      user: {
        findFirst: jest.fn(async () => ({
          userType: UserType.Passenger,
          isActive: true,
        })),
      },
    };
    const guard = new AdminOnlyGuard(prisma as never);
    await expect(guard.canActivate(context('rider-1'))).rejects.toBeInstanceOf(
      ForbiddenAppException,
    );
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'rider-1', isDeleted: false },
      select: { userType: true, isActive: true },
    });
  });

  it('allows an active admin row', async () => {
    const guard = new AdminOnlyGuard({
      user: {
        findFirst: async () => ({ userType: UserType.Admin, isActive: true }),
      },
    } as never);
    await expect(guard.canActivate(context('admin-1'))).resolves.toBe(true);
  });
});
