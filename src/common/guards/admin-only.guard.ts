import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../../database/prisma/prisma.service';
import {
  ForbiddenAppException,
  UnauthorizedAppException,
} from '../exceptions/app.exception';
import { extractBearer } from './optional-jwt.guard';
import { UserType } from '../enums';

@Injectable()
export class AdminOnlyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as { userId?: string } | undefined;
    const userId = user?.userId;

    if (!userId) {
      if (extractBearer(request) || request.jwtAuthFailed) {
        throw new UnauthorizedAppException(
          'رمز الدخول غير صالح أو منتهي. سجّل الدخول مرة أخرى من لوحة التحكم',
        );
      }
      throw new UnauthorizedAppException('يجب تسجيل الدخول كمسؤول');
    }

    const row = await this.prisma.user.findFirst({
      where: { id: userId, isDeleted: false },
      select: { userType: true, isActive: true },
    });
    if (!row?.isActive || row.userType !== UserType.Admin) {
      throw new ForbiddenAppException('هذا الإجراء متاح للمسؤولين فقط');
    }

    return true;
  }
}
