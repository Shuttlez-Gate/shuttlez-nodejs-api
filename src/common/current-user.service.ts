import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Request } from 'express';
import { UnauthorizedAppException } from './exceptions/app.exception';

interface JwtUser {
  userId?: string;
  phone?: string;
  role?: string;
}

@Injectable({ scope: Scope.REQUEST })
export class CurrentUserService {
  constructor(@Inject(REQUEST) private readonly request: Request) {}

  private get jwtUser(): JwtUser {
    return (this.request.user as JwtUser) ?? {};
  }

  get userId(): string | undefined {
    return this.jwtUser.userId;
  }

  get phone(): string | undefined {
    return this.jwtUser.phone;
  }

  get isAuthenticated(): boolean {
    return Boolean(this.jwtUser.userId);
  }

  get role(): string | undefined {
    return this.jwtUser.role;
  }

  get isAdmin(): boolean {
    return this.role?.toLowerCase() === 'admin';
  }

  requireUserId(message = 'غير مصرح'): string {
    if (!this.userId) {
      throw new UnauthorizedAppException(message);
    }
    return this.userId;
  }
}
