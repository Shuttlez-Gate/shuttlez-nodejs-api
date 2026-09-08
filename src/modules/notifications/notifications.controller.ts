import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';
import { CurrentUserService } from '../../common/current-user.service';
import { NotFoundException } from '../../common/exceptions/app.exception';
import { PrismaService } from '../../database/prisma/prisma.service';
import { newId, utcNow } from '../../common/utils/date.util';
import { baseFields } from '../../common/utils/entity-defaults';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('api/v1/notifications')
export class NotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get('me')
  async me() {
    const userId = this.currentUser.requireUserId();
    const items = await this.prisma.notification.findMany({
      where: { userId, isDeleted: false },
      orderBy: { createdAt: 'desc' },
    });
    const mapped = items.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      time: formatHm(n.createdAt),
      isUnread: !n.isRead,
      createdAt: n.createdAt,
    }));
    const groups = new Map<string, typeof mapped>();
    for (const item of mapped) {
      const key = formatDateLabel(item.createdAt);
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    }
    return ApiResponse.ok(
      [...groups.entries()].map(([dateLabel, groupItems]) => ({
        dateLabel,
        items: groupItems,
      })),
    );
  }

  @Patch(':id/read')
  async read(@Param('id') id: string) {
    const userId = this.currentUser.requireUserId();
    const notification = await this.prisma.notification.findFirst({
      where: { id, userId, isDeleted: false },
    });
    if (!notification) {
      throw new NotFoundException('الإشعار غير موجود');
    }
    await this.prisma.notification.update({
      where: { id },
      data: { isRead: true, readAt: utcNow() },
    });
    return ApiResponse.ok(true);
  }

  @Post('devices')
  async register(@Body() body: { token: string; platform?: string }) {
    const userId = this.currentUser.requireUserId();
    const token = (body.token ?? '').trim();
    const platform = (body.platform ?? 'android').trim() || 'android';
    const existing = await this.prisma.userDevice.findFirst({
      where: { userId, token },
    });
    if (existing) {
      await this.prisma.userDevice.update({
        where: { id: existing.id },
        data: { isActive: true, platform, lastSeenAt: utcNow(), isDeleted: false },
      });
    } else {
      await this.prisma.userDevice.create({
        data: {
          id: newId(),
          userId,
          token,
          platform,
          isActive: true,
          lastSeenAt: utcNow(),
          ...baseFields(),
        },
      });
    }
    return ApiResponse.ok(true);
  }

  @Delete('devices/:token')
  async unregister(@Param('token') token: string) {
    const userId = this.currentUser.requireUserId();
    const decoded = decodeURIComponent(token);
    await this.prisma.userDevice.updateMany({
      where: { userId, token: decoded },
      data: { isActive: false, updatedAt: utcNow() },
    });
    return ApiResponse.ok(true);
  }
}

function formatHm(date: Date): string {
  const hh = date.getUTCHours().toString().padStart(2, '0');
  const mm = date.getUTCMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatDateLabel(date: Date): string {
  const dd = date.getUTCDate().toString().padStart(2, '0');
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}
