import { UnauthorizedAppException } from '../../common/exceptions/app.exception';
import { UserType } from '../../common/enums';
import { AuthRateLimiter } from './auth-rate-limiter';
import { AuthService } from './auth.service';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  passwordMatches,
  verifyPassword,
} from './password.util';

const password = 'Admin-pass-1';

function adminService(user: Record<string, unknown> | null) {
  const firebase = { verifyPhone: jest.fn(), consumePhoneToken: jest.fn() };
  const otp = { sendOtp: jest.fn() };
  const prisma = {
    user: { findFirst: jest.fn(async () => user) },
    refreshToken: { create: jest.fn(async () => ({})) },
  };
  const jwt = {
    generateRefreshToken: () => 'refresh-plain',
    generateAccessToken: () => 'access-plain',
    accessTokenExpiresAt: () => new Date('2026-11-01T00:00:00Z'),
  };
  const service = new AuthService(
    prisma as never,
    otp as never,
    jwt as never,
    {} as never,
    firebase as never,
    {} as never,
    new AuthRateLimiter(),
  );
  return { service, firebase, otp, prisma };
}

describe('admin password login', () => {
  it('stores a scrypt hash that does not contain the password', async () => {
    const stored = await hashPassword(password);
    expect(stored.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(stored).not.toContain(password);
    expect(await verifyPassword(password, stored)).toBe(true);
    expect(await verifyPassword('wrong-pass-1', stored)).toBe(false);
    expect(await verifyPassword('dummy-admin-password-not-used', DUMMY_PASSWORD_HASH)).toBe(
      true,
    );
  });

  it('does not accept a missing hash as a match', async () => {
    expect(await passwordMatches(password, null)).toBe(false);
  });

  it('issues a session only for an active admin with the right password', async () => {
    const stored = await hashPassword(password);
    const { service, firebase, prisma } = adminService({
      id: 'admin-1',
      phone: '+201000000099',
      userType: UserType.Admin,
      isActive: true,
      passwordHash: stored,
      fullName: 'Admin',
      email: null,
      avatarUrl: null,
    });

    const result = await service.adminLogin(
      { phone: '01000000099', password },
      '127.0.0.1',
    );

    expect(result.accessToken).toBe('access-plain');
    expect(result.admin.role).toBe('Admin');
    expect(result).not.toHaveProperty('passwordHash');
    expect(firebase.verifyPhone).not.toHaveBeenCalled();
    expect(prisma.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ platform: 'admin' }),
      }),
    );
    const storedToken = (
      prisma.refreshToken.create.mock.calls as unknown as Array<[{ data: { token: string } }]>
    )[0][0].data.token;
    expect(storedToken).not.toBe('refresh-plain');
  });

  it('rejects a rider, a wrong password, and an admin with no password', async () => {
    const stored = await hashPassword(password);
    const cases = [
      {
        id: 'rider',
        phone: '+201000000101',
        userType: UserType.Passenger,
        isActive: true,
        passwordHash: stored,
      },
      {
        id: 'admin-1',
        phone: '+201000000099',
        userType: UserType.Admin,
        isActive: true,
        passwordHash: stored,
      },
      {
        id: 'admin-1',
        phone: '+201000000099',
        userType: UserType.Admin,
        isActive: false,
        passwordHash: stored,
      },
      {
        id: 'admin-1',
        phone: '+201000000099',
        userType: UserType.Admin,
        isActive: true,
        passwordHash: null,
      },
    ];
    const passwords = [password, 'wrong-pass-1', password, password];

    for (let i = 0; i < cases.length; i += 1) {
      const { service, firebase } = adminService(cases[i]);
      await expect(
        service.adminLogin({ phone: cases[i].phone, password: passwords[i] }),
      ).rejects.toBeInstanceOf(UnauthorizedAppException);
      expect(firebase.verifyPhone).not.toHaveBeenCalled();
    }
  });

  it('does not send an admin OTP or reveal whether the phone is an admin', async () => {
    const { service, otp } = adminService(null);
    const result = await service.sendAdminOtp('01000000099');
    expect(result.message).toContain('كلمة المرور');
    expect(otp.sendOtp).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('debugCode');
  });
});
