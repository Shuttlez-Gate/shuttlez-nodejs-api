import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import {
  ForbiddenAppException,
  UnauthorizedAppException,
} from '../exceptions/app.exception';
import { extractBearer } from './optional-jwt.guard';
import { UserType } from '../enums';

const ROLE_CLAIM_TYPES = new Set([
  'role',
  'roles',
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/role',
]);

@Injectable()
export class AdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as Record<string, unknown> | undefined;

    if (!user) {
      if (extractBearer(request) || request.jwtAuthFailed) {
        throw new UnauthorizedAppException(
          'رمز الدخول غير صالح أو منتهي. سجّل الدخول مرة أخرى من لوحة التحكم',
        );
      }
      throw new UnauthorizedAppException('يجب تسجيل الدخول كمسؤول');
    }

    if (!isAdmin(user)) {
      throw new ForbiddenAppException('هذا الإجراء متاح للمسؤولين فقط');
    }

    return true;
  }
}

function isAdmin(user: Record<string, unknown>): boolean {
  const role = extractRole(user);
  if (role?.toLowerCase() === 'admin' || role === String(UserType.Admin)) {
    return true;
  }
  return user.userType === UserType.Admin;
}

export function extractRole(user: Record<string, unknown>): string | undefined {
  const direct =
    (user.role as string | undefined) ??
    (user.userType as string | undefined) ??
    (user['http://schemas.microsoft.com/ws/2008/06/identity/claims/role'] as
      | string
      | undefined);
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }

  const payload = user as Record<string, unknown>;
  for (const [key, value] of Object.entries(payload)) {
    if (
      ROLE_CLAIM_TYPES.has(key) ||
      key.toLowerCase().endsWith('/identity/claims/role')
    ) {
      if (typeof value === 'string') {
        return value;
      }
    }
  }
  return undefined;
}
