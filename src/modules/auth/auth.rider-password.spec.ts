import { Prisma } from '@prisma/client';
import { UnauthorizedAppException } from '../../common/exceptions/app.exception';
import { UserType } from '../../common/enums';
import { AuthRateLimiter } from './auth-rate-limiter';
import { AuthService } from './auth.service';
import { hashPassword, verifyPassword } from './password.util';

const phone = '+201000000101';
const password = 'Riderpass1';

type PrismaMock = {
  user: {
    findFirst: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  wallet: { create: jest.Mock };
  driver: { create: jest.Mock };
  refreshToken: { create: jest.Mock; updateMany: jest.Mock };
  $transaction: jest.Mock;
};

function riderService(initial: Record<string, unknown> | null) {
  let user = initial;
  const revoked: Array<Record<string, unknown>> = [];
  const createdTokens: Array<Record<string, unknown>> = [];
  const prisma: PrismaMock = {
    user: {
      findFirst: jest.fn(async () => user),
      findUniqueOrThrow: jest.fn(async () => user),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        user = {
          ...data,
          isDeleted: false,
          isActive: true,
          userType: data.userType ?? UserType.Passenger,
        };
        return user;
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        user = { ...(user ?? {}), ...data };
        return user;
      }),
    },
    wallet: { create: jest.fn(async () => ({})) },
    driver: { create: jest.fn(async () => ({})) },
    refreshToken: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        createdTokens.push(data);
        return data;
      }),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        revoked.push(data);
        return { count: 1 };
      }),
    },
    $transaction: jest.fn(async (arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: typeof prisma) => Promise<unknown>)(prisma);
      }
      return Promise.all(arg as Promise<unknown>[]);
    }),
  };
  const currentUser = {
    requireUserId: (message?: string) => {
      if (!user) throw new UnauthorizedAppException(message ?? 'يجب تسجيل الدخول');
      return String(user.id);
    },
    sessionId: 'session-1',
  };
  const service = new AuthService(
    prisma as never,
    {} as never,
    {
      generateRefreshToken: () => 'refresh-plain',
      generateAccessToken: () => 'access-plain',
      accessTokenExpiresAt: () => new Date('2026-11-17T00:00:00Z'),
    } as never,
    currentUser as never,
    { consumePhoneToken: jest.fn(), verifyPhone: jest.fn() } as never,
    {} as never,
    new AuthRateLimiter(),
  );
  return {
    service,
    prisma,
    revoked,
    createdTokens,
    readUser: () => user,
  };
}

describe('rider password authentication', () => {
  it('registers with a scrypt hash and does not mark the phone as Firebase-verified', async () => {
    const { service, prisma, readUser } = riderService(null);
    const result = await service.register(
      {
        phone: '01000000101',
        fullName: 'راكب تجريبي',
        email: '',
        gender: 'ذكر',
        password,
      },
      '127.0.0.1',
    );

    const stored = readUser();
    expect(stored?.passwordHash).toEqual(expect.any(String));
    expect(String(stored?.passwordHash)).not.toContain(password);
    expect(await verifyPassword(password, String(stored?.passwordHash))).toBe(true);
    expect(stored?.firebasePhoneUid).toBeNull();
    expect(result.user.hasPassword).toBe(true);
    expect(result.tokens.accessToken).toBe('access-plain');
    expect(result).not.toHaveProperty('passwordHash');
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          wallet: {
            create: expect.objectContaining({
              id: expect.any(String),
              currency: 'EGP',
              balance: 0,
            }),
          },
        }),
      }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('rejects a weak password and a duplicate phone', async () => {
    const fresh = riderService(null);
    await expect(
      fresh.service.register(
        {
          phone,
          fullName: 'راكب تجريبي',
          gender: 'male',
          password: 'password',
        },
        '127.0.0.1',
      ),
    ).rejects.toMatchObject({ code: 'PASSWORD_WEAK' });

    const duplicate = riderService(null);
    duplicate.prisma.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate phone', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      duplicate.service.register(
        {
          phone,
          fullName: 'راكب تجريبي',
          gender: 'male',
          password,
        },
        '127.0.0.1',
      ),
    ).rejects.toMatchObject({ code: 'PHONE_ALREADY_REGISTERED' });
  });

  it('logs in with the right password and hides unknown accounts and missing hashes', async () => {
    const stored = await hashPassword(password);
    const ok = riderService({
      id: 'user-1',
      phone,
      isDeleted: false,
      isActive: true,
      userType: UserType.Passenger,
      passwordHash: stored,
      fullName: 'راكب',
      email: null,
      gender: null,
      avatarUrl: null,
      ratingAverage: 0,
      ratingCount: 0,
    });
    const session = await ok.service.loginWithPassword(
      { phone: '01000000101', password },
      '127.0.0.1',
    );
    expect(session.tokens.refreshToken).toBe('refresh-plain');
    expect(session.user).not.toHaveProperty('passwordHash');

    const wrong = riderService({
      id: 'user-1',
      phone,
      isDeleted: false,
      isActive: true,
      userType: UserType.Passenger,
      passwordHash: stored,
    });
    await expect(
      wrong.service.loginWithPassword({ phone, password: 'Otherpass1' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedAppException);

    const missing = riderService(null);
    await expect(
      missing.service.loginWithPassword({ phone, password }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedAppException);

    const noPassword = riderService({
      id: 'user-1',
      phone,
      isDeleted: false,
      isActive: true,
      userType: UserType.Passenger,
      passwordHash: null,
    });
    await expect(
      noPassword.service.loginWithPassword({ phone, password }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedAppException);
  });

  it('changes the password, rejects the old one, and accepts the new one', async () => {
    const stored = await hashPassword(password);
    const harness = riderService({
      id: 'user-1',
      phone,
      isDeleted: false,
      isActive: true,
      userType: UserType.Passenger,
      passwordHash: stored,
      fullName: 'راكب',
      email: null,
      gender: null,
      avatarUrl: null,
      ratingAverage: 0,
      ratingCount: 0,
    });

    await expect(
      harness.service.changePassword(
        { currentPassword: 'Otherpass1', newPassword: 'Newrider1' },
        '127.0.0.1',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedAppException);

    await expect(
      harness.service.changePassword(
        { currentPassword: password, newPassword: password },
        '127.0.0.1',
      ),
    ).rejects.toMatchObject({ code: 'PASSWORD_REUSED' });

    const changed = await harness.service.changePassword(
      { currentPassword: password, newPassword: 'Newrider1' },
      '127.0.0.1',
    );
    expect(changed.user.hasPassword).toBe(true);
    expect(harness.revoked).toHaveLength(1);
    expect(harness.createdTokens.length).toBeGreaterThan(0);
    const nextHash = String(harness.readUser()?.passwordHash);
    expect(await verifyPassword(password, nextHash)).toBe(false);
    expect(await verifyPassword('Newrider1', nextHash)).toBe(true);

    await expect(
      harness.service.loginWithPassword({ phone, password }, '10.0.0.2'),
    ).rejects.toBeInstanceOf(UnauthorizedAppException);
    const session = await harness.service.loginWithPassword(
      { phone, password: 'Newrider1' },
      '10.0.0.3',
    );
    expect(session.tokens.accessToken).toBe('access-plain');
  });

  it('lets an authenticated account without a password set the first one', async () => {
    const harness = riderService({
      id: 'user-1',
      phone,
      isDeleted: false,
      isActive: true,
      userType: UserType.Passenger,
      passwordHash: null,
      fullName: 'راكب',
      email: null,
      gender: null,
      avatarUrl: null,
      ratingAverage: 0,
      ratingCount: 0,
    });
    await expect(
      harness.service.loginWithPassword({ phone, password }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedAppException);

    const created = await harness.service.changePassword(
      { newPassword: password },
      '127.0.0.1',
    );
    expect(created.user.hasPassword).toBe(true);
    const session = await harness.service.loginWithPassword(
      { phone, password },
      '127.0.0.2',
    );
    expect(session.user.phone).toBe(phone);
  });
});
