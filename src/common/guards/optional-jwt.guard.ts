import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { UserType, userTypeName } from '../enums';

/**
 * Mirrors ASP.NET JwtBearer OnAuthenticationFailed = NoResult:
 * invalid/expired tokens do not block public endpoints.
 * Handlers that need a user throw UnauthorizedAppException themselves.
 */
@Injectable()
export class OptionalJwtGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = extractBearer(request) ?? extractHubQueryToken(request);
    if (!token) {
      return true;
    }

    try {
      const payload = this.jwt.verify<Record<string, unknown>>(token, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        issuer: this.config.get<string>('JWT_ISSUER', 'Shuttlez'),
        audience: this.config.get<string>('JWT_AUDIENCE', 'ShuttlezApp'),
        clockTolerance: 60,
      });
      request.user = normalizePayload(payload);
    } catch {
      // Match .NET: do not fail the request for a bad token on public routes.
    }

    return true;
  }
}

export function extractBearer(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (!header) {
    return undefined;
  }
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) {
    return undefined;
  }
  return value;
}

function extractHubQueryToken(request: Request): string | undefined {
  if (!request.path.startsWith('/hubs')) {
    return undefined;
  }
  const token = request.query.access_token;
  return typeof token === 'string' ? token : undefined;
}

const NAME_ID =
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier';
const ROLE_URI =
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/role';
const MOBILE =
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/mobilephone';

export function normalizePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const userId =
    (payload[NAME_ID] as string | undefined) ??
    (payload.sub as string | undefined) ??
    (payload.nameid as string | undefined);
  const phone =
    (payload[MOBILE] as string | undefined) ??
    (payload.phone_number as string | undefined);
  const role =
    (payload[ROLE_URI] as string | undefined) ??
    (payload.role as string | undefined) ??
    (typeof payload.userType === 'number'
      ? userTypeName(payload.userType as UserType)
      : undefined);

  return {
    ...payload,
    userId,
    phone,
    role,
  };
}
