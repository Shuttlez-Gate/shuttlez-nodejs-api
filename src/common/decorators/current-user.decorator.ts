import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

export interface AuthUser {
  userId?: string;
  phone?: string;
  role?: string;
}

export const CurrentAuthUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return (request.user as AuthUser) ?? {};
  },
);
