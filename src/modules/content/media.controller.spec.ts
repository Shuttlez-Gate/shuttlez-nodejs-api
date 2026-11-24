import { UserType } from '../../common/enums';
import { UnauthorizedAppException } from '../../common/exceptions/app.exception';
import { CurrentUserService } from '../../common/current-user.service';
import { PrismaService } from '../../database/prisma/prisma.service';
import { MediaController } from './media.controller';

const ownerUserId = '00000000-0000-4000-8000-000000000001';
const otherDriverUserId = '00000000-0000-4000-8000-000000000002';
const documentId = '00000000-0000-4000-8000-000000000003';

describe('MediaController driver document privacy', () => {
  let controller: MediaController;
  let caller: { id: string; userType: number; isActive: boolean } | null;
  let document: Record<string, unknown> | null;
  let findDocument: jest.Mock;

  function response() {
    const headers = new Map<string, string>();
    const state: { statusCode: number; sent: unknown; redirectedTo: string | null } = {
      statusCode: 200,
      sent: undefined,
      redirectedTo: null,
    };
    const res = {
      setHeader: jest.fn((key: string, value: string) => { headers.set(key.toLowerCase(), value); return res; }),
      status: jest.fn((code: number) => { state.statusCode = code; return res; }),
      send: jest.fn((body: unknown) => { state.sent = body; return res; }),
      redirect: jest.fn((url: string) => { state.redirectedTo = url; return res; }),
    };
    return { res, headers, state };
  }

  beforeEach(() => {
    caller = { id: ownerUserId, userType: UserType.Driver, isActive: true };
    document = {
      id: documentId,
      fileName: 'license.jpg',
      contentType: 'image/jpeg',
      storagePath: 'data:image/jpeg;base64,aGVsbG8=',
      isDeleted: false,
      driver: { userId: ownerUserId, isDeleted: false },
    };
    findDocument = jest.fn(async () => document);
    const prisma = {
      user: { findFirst: jest.fn(async () => caller) },
      driverDocument: { findFirst: findDocument },
    };
    const currentUser = {
      requireUserId: jest.fn(() => {
        if (!caller) throw new UnauthorizedAppException('Authentication is required');
        return caller.id;
      }),
    };
    controller = new MediaController(
      prisma as unknown as PrismaService,
      currentUser as unknown as CurrentUserService,
    );
  });

  it('rejects unauthenticated requests before looking up or sending document bytes', async () => {
    caller = null;
    const { res, headers, state } = response();
    await expect(controller.driverDocument(documentId, res as never)).rejects.toBeInstanceOf(UnauthorizedAppException);
    expect(headers.get('cache-control')).toContain('no-store');
    expect(findDocument).not.toHaveBeenCalled();
    expect(state.sent).toBeUndefined();
  });

  it.each([
    ['a rider', UserType.Passenger, otherDriverUserId],
    ['an unrelated driver', UserType.Driver, otherDriverUserId],
  ])('returns the same safe 404 to %s without document bytes', async (_label, userType, userId) => {
    caller = { id: userId, userType, isActive: true };
    const { res, state, headers } = response();
    await controller.driverDocument(documentId, res as never);
    expect(state.statusCode).toBe(404);
    expect(state.sent).toBe('Document not found');
    expect(state.sent).not.toBeInstanceOf(Buffer);
    expect(headers.get('cache-control')).toContain('no-store');
  });

  it('allows the owning driver to retrieve their own document', async () => {
    const { res, state, headers } = response();
    await controller.driverDocument(documentId, res as never);
    expect(state.statusCode).toBe(200);
    expect(Buffer.isBuffer(state.sent)).toBe(true);
    expect((state.sent as Buffer).toString()).toBe('hello');
    expect(headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(headers.get('surrogate-control')).toBe('no-store');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('allows an active administrator to retrieve another driver document', async () => {
    caller = { id: otherDriverUserId, userType: UserType.Admin, isActive: true };
    const { res, state } = response();
    await controller.driverDocument(documentId, res as never);
    expect(state.statusCode).toBe(200);
    expect(Buffer.isBuffer(state.sent)).toBe(true);
  });

  it('returns a safe 404 for nonexistent and malformed document IDs', async () => {
    const { res, state } = response();
    document = null;
    await controller.driverDocument(documentId, res as never);
    expect(state.statusCode).toBe(404);
    expect(state.sent).toBe('Document not found');

    findDocument.mockClear();
    const malformed = response();
    await controller.driverDocument('not-a-uuid', malformed.res as never);
    expect(malformed.state.statusCode).toBe(404);
    expect(findDocument).not.toHaveBeenCalled();
  });

  it('does not redirect legacy external storage URLs', async () => {
    document = { ...document, storagePath: 'https://files.example.invalid/private.jpg' };
    const { res, state } = response();
    await controller.driverDocument(documentId, res as never);
    expect(state.statusCode).toBe(404);
    expect(state.redirectedTo).toBeNull();
    expect(state.sent).toBe('Document not found');
  });

  it('uses attachment delivery for active or unknown content types', async () => {
    document = { ...document, contentType: 'text/html', storagePath: 'data:text/html;base64,PGgxPm5vPC9oMT4=' };
    const { res, headers } = response();
    await controller.driverDocument(documentId, res as never);
    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('content-disposition')).toContain('attachment;');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });
});
