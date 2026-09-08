import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { ApiResponse } from '../../common/api-response';
import { AdminOnly } from '../../common/decorators/admin-only.decorator';
import { PrismaService } from '../../database/prisma/prisma.service';
import { CurrentUserService } from '../../common/current-user.service';
import { NotFoundException } from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import { pageRequestFrom, PagedResult } from '../../common/paged-result';
import { newId, utcNow } from '../../common/utils/date.util';
import { baseFields } from '../../common/utils/entity-defaults';
import { parseGroupStatus, parseRideStatus } from '../../common/utils/enums-map';
import { GroupRequestStatus, RideRequestStatus } from '../../common/enums';
import { RidesService } from '../rides/rides.service';
import { GroupsService } from '../groups/groups.service';

@ApiTags('admin-support')
@AdminOnly()
@Controller('api/v1/admin/support')
export class AdminSupportController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get('tickets')
  async tickets(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const where: Prisma.SupportTicketWhereInput = {
      isDeleted: false,
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { subject: { contains: search } },
              { user: { phone: { contains: search } } },
            ],
          }
        : {}),
    };
    const [items, totalCount] = await this.prisma.$transaction([
      this.prisma.supportTicket.findMany({
        where,
        skip: paging.skip,
        take: paging.pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          user: true,
          messages: { where: { isDeleted: false }, orderBy: { createdAt: 'desc' } },
        },
      }),
      this.prisma.supportTicket.count({ where }),
    ]);
    return ApiResponse.ok(
      new PagedResult(
        items.map((t) => ({
          id: t.id,
          userId: t.userId,
          userPhone: t.user.phone,
          userName: t.user.fullName,
          tripId: t.tripId,
          subject: t.subject,
          status: t.status,
          messageCount: t.messages.length,
          lastMessage: t.messages[0]?.content ?? null,
          lastMessageAt: t.messages[0]?.createdAt ?? null,
          closedAt: t.closedAt,
          createdAt: t.createdAt,
        })),
        paging.page,
        paging.pageSize,
        totalCount,
      ),
    );
  }

  @Get('tickets/:id/messages')
  async messages(@Param('id') id: string) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id, isDeleted: false },
    });
    if (!ticket) {
      throw new NotFoundException('التذكرة غير موجودة');
    }
    const items = await this.prisma.supportMessage.findMany({
      where: { ticketId: id, isDeleted: false },
      orderBy: { createdAt: 'asc' },
    });
    return ApiResponse.ok(
      items.map((m) => ({
        id: m.id,
        ticketId: m.ticketId,
        isFromSupport: m.isFromSupport,
        content: m.content,
        createdAt: m.createdAt,
      })),
    );
  }

  @Post('tickets/:id/messages')
  async reply(@Param('id') id: string, @Body() body: { content: string }) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id, isDeleted: false },
    });
    if (!ticket) {
      throw new NotFoundException('التذكرة غير موجودة');
    }
    const senderId = this.currentUser.requireUserId();
    const message = await this.prisma.supportMessage.create({
      data: {
        id: newId(),
        ticketId: id,
        senderId,
        isFromSupport: true,
        content: body.content,
        ...baseFields(),
      },
    });
    await this.prisma.supportTicket.update({
      where: { id },
      data: { updatedAt: utcNow(), status: ticket.status === 'closed' ? ticket.status : 'open' },
    });
    return ApiResponse.ok(
      {
        id: message.id,
        ticketId: message.ticketId,
        isFromSupport: true,
        content: message.content,
        createdAt: message.createdAt,
      },
      'تم إرسال الرد',
    );
  }

  @Patch('tickets/:id/status')
  async updateStatus(@Param('id') id: string, @Body() body: { status: string }) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id, isDeleted: false },
      include: { user: true, messages: true },
    });
    if (!ticket) {
      throw new NotFoundException('التذكرة غير موجودة');
    }
    const updated = await this.prisma.supportTicket.update({
      where: { id },
      data: {
        status: body.status,
        closedAt: body.status === 'closed' ? utcNow() : null,
        updatedAt: utcNow(),
      },
      include: { user: true, messages: true },
    });
    return ApiResponse.ok(
      {
        id: updated.id,
        userId: updated.userId,
        userPhone: updated.user.phone,
        userName: updated.user.fullName,
        tripId: updated.tripId,
        subject: updated.subject,
        status: updated.status,
        messageCount: updated.messages.length,
        lastMessage: null,
        lastMessageAt: null,
        closedAt: updated.closedAt,
        createdAt: updated.createdAt,
      },
      'تم تحديث التذكرة',
    );
  }
}

@ApiTags('admin-notifications')
@AdminOnly()
@Controller('api/v1/admin/notifications')
export class AdminNotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query('userId') userId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const where: Prisma.NotificationWhereInput = {
      isDeleted: false,
      ...(userId ? { userId } : {}),
    };
    const [items, totalCount] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        skip: paging.skip,
        take: paging.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { user: true },
      }),
      this.prisma.notification.count({ where }),
    ]);
    return ApiResponse.ok(
      new PagedResult(
        items.map((n) => ({
          id: n.id,
          userId: n.userId,
          userPhone: n.user.phone,
          title: n.title,
          body: n.body,
          type: n.type,
          isRead: n.isRead,
          createdAt: n.createdAt,
        })),
        paging.page,
        paging.pageSize,
        totalCount,
      ),
    );
  }

  @Post('broadcast')
  async broadcast(
    @Body()
    body: {
      title: string;
      body: string;
      audience?: string;
      userIds?: string[];
      type?: string;
    },
  ) {
    let userIds = body.userIds ?? [];
    if (!userIds.length) {
      const audience = (body.audience ?? 'all').toLowerCase();
      const users = await this.prisma.user.findMany({
        where: {
          isDeleted: false,
          isActive: true,
          ...(audience === 'drivers' ? { userType: 2 } : {}),
          ...(audience === 'passengers' ? { userType: 1 } : {}),
        },
        select: { id: true },
      });
      userIds = users.map((u) => u.id);
    }
    if (userIds.length) {
      await this.prisma.notification.createMany({
        data: userIds.map((userId) => ({
          id: newId(),
          userId,
          title: body.title,
          body: body.body,
          type: body.type ?? 'admin',
          isRead: false,
          ...baseFields(),
        })),
      });
    }
    return ApiResponse.ok({ sent: userIds.length }, 'تم إرسال الإشعار');
  }
}

@ApiTags('admin-rides')
@AdminOnly()
@Controller('api/v1/admin/rides')
export class AdminRidesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rides: RidesService,
  ) {}

  @Get()
  async list(
    @Query('status') status?: string,
    @Query('driverId') driverId?: string,
    @Query('riderUserId') riderUserId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const parsed = parseRideStatus(status);
    const where: Prisma.RideRequestWhereInput = {
      isDeleted: false,
      ...(parsed != null ? { status: parsed } : {}),
      ...(driverId ? { driverId } : {}),
      ...(riderUserId ? { riderUserId } : {}),
    };
    const [items, totalCount] = await this.prisma.$transaction([
      this.prisma.rideRequest.findMany({
        where,
        skip: paging.skip,
        take: paging.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { driver: { include: { user: true, vehicle: true } } },
      }),
      this.prisma.rideRequest.count({ where }),
    ]);
    return ApiResponse.ok(
      new PagedResult(
        items.map((r) => this.rides.mapRide(r)),
        paging.page,
        paging.pageSize,
        totalCount,
      ),
    );
  }

  @Put(':rideId/driver')
  async assign(
    @Param('rideId') rideId: string,
    @Body() body: { driverId: string },
  ) {
    const ride = await this.prisma.rideRequest.findFirst({
      where: { id: rideId, isDeleted: false },
    });
    if (!ride) {
      throw new NotFoundException('المشوار غير موجود', ErrorCodes.RideNotFound);
    }
    const driver = await this.prisma.driver.findFirst({
      where: { id: body.driverId, isDeleted: false, isActive: true },
    });
    if (!driver) {
      throw new NotFoundException('الكابتن غير موجود', ErrorCodes.DriverNotFound);
    }
    const updated = await this.prisma.rideRequest.update({
      where: { id: rideId },
      data: {
        driverId: driver.id,
        status: RideRequestStatus.Assigned,
        assignedAt: utcNow(),
        updatedAt: utcNow(),
      },
      include: { driver: { include: { user: true, vehicle: true } } },
    });
    return ApiResponse.ok(this.rides.mapRide(updated), 'تم تعيين الكابتن');
  }

  @Delete(':rideId/driver')
  async unassign(@Param('rideId') rideId: string) {
    const ride = await this.prisma.rideRequest.findFirst({
      where: { id: rideId, isDeleted: false },
    });
    if (!ride) {
      throw new NotFoundException('المشوار غير موجود', ErrorCodes.RideNotFound);
    }
    const updated = await this.prisma.rideRequest.update({
      where: { id: rideId },
      data: {
        driverId: null,
        status: RideRequestStatus.Requested,
        assignedAt: null,
        updatedAt: utcNow(),
      },
      include: { driver: { include: { user: true, vehicle: true } } },
    });
    return ApiResponse.ok(this.rides.mapRide(updated), 'تم إلغاء تعيين الكابتن');
  }
}

@ApiTags('admin-groups')
@AdminOnly()
@Controller('api/v1/admin/groups')
export class AdminGroupsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly groups: GroupsService,
  ) {}

  @Get()
  async list(
    @Query('status') status?: string,
    @Query('driverId') driverId?: string,
    @Query('organizerUserId') organizerUserId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const paging = pageRequestFrom(Number(page), Number(pageSize));
    const parsed = parseGroupStatus(status);
    const where: Prisma.GroupRequestWhereInput = {
      isDeleted: false,
      ...(parsed != null ? { status: parsed } : {}),
      ...(driverId ? { driverId } : {}),
      ...(organizerUserId ? { organizerUserId } : {}),
    };
    const [items, totalCount] = await this.prisma.$transaction([
      this.prisma.groupRequest.findMany({
        where,
        skip: paging.skip,
        take: paging.pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          driver: { include: { user: true } },
          members: { include: { user: true } },
        },
      }),
      this.prisma.groupRequest.count({ where }),
    ]);
    return ApiResponse.ok(
      new PagedResult(
        items.map((g) => this.groups.mapGroup(g)),
        paging.page,
        paging.pageSize,
        totalCount,
      ),
    );
  }

  @Put(':groupId/driver')
  async assign(
    @Param('groupId') groupId: string,
    @Body() body: { driverId: string },
  ) {
    const group = await this.prisma.groupRequest.findFirst({
      where: { id: groupId, isDeleted: false },
    });
    if (!group) {
      throw new NotFoundException('المجموعة غير موجودة', ErrorCodes.GroupNotFound);
    }
    const driver = await this.prisma.driver.findFirst({
      where: { id: body.driverId, isDeleted: false, isActive: true },
    });
    if (!driver) {
      throw new NotFoundException('الكابتن غير موجود', ErrorCodes.DriverNotFound);
    }
    await this.prisma.groupRequest.update({
      where: { id: groupId },
      data: {
        driverId: driver.id,
        status: GroupRequestStatus.Assigned,
        assignedAt: utcNow(),
        updatedAt: utcNow(),
      },
    });
    return ApiResponse.ok(await this.groups.mapGroup(await this.loadGroup(groupId)), 'تم تعيين الكابتن');
  }

  @Delete(':groupId/driver')
  async unassign(@Param('groupId') groupId: string) {
    const group = await this.prisma.groupRequest.findFirst({
      where: { id: groupId, isDeleted: false },
    });
    if (!group) {
      throw new NotFoundException('المجموعة غير موجودة', ErrorCodes.GroupNotFound);
    }
    await this.prisma.groupRequest.update({
      where: { id: groupId },
      data: {
        driverId: null,
        status: GroupRequestStatus.Confirmed,
        assignedAt: null,
        updatedAt: utcNow(),
      },
    });
    return ApiResponse.ok(
      await this.groups.mapGroup(await this.loadGroup(groupId)),
      'تم إلغاء تعيين الكابتن',
    );
  }

  private async loadGroup(id: string) {
    const group = await this.prisma.groupRequest.findFirst({
      where: { id },
      include: {
        driver: { include: { user: true } },
        members: { include: { user: true } },
      },
    });
    if (!group) {
      throw new NotFoundException('المجموعة غير موجودة', ErrorCodes.GroupNotFound);
    }
    return group;
  }
}

@ApiTags('admin-dashboard')
@AdminOnly()
@Controller('api/v1/admin/dashboard')
export class AdminDashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async get(@Query('days') days = '30') {
    const windowDays = Number(days) > 0 ? Number(days) : 30;
    const from = new Date(Date.now() - windowDays * 86400000);
    const [users, trips, bookings, revenueAgg] = await Promise.all([
      this.prisma.user.count({ where: { isDeleted: false, createdAt: { gte: from } } }),
      this.prisma.trip.count({ where: { isDeleted: false, createdAt: { gte: from } } }),
      this.prisma.booking.count({ where: { isDeleted: false, createdAt: { gte: from } } }),
      this.prisma.booking.aggregate({
        where: { isDeleted: false, createdAt: { gte: from } },
        _sum: { totalAmount: true },
      }),
    ]);
    const tripBreakdown = await this.prisma.trip.groupBy({
      by: ['status'],
      where: { isDeleted: false, createdAt: { gte: from } },
      _count: { _all: true },
    });
    const bookingBreakdown = await this.prisma.booking.groupBy({
      by: ['status'],
      where: { isDeleted: false, createdAt: { gte: from } },
      _count: { _all: true },
    });
    return ApiResponse.ok({
      metrics: [
        { key: 'users', label: 'المستخدمون', value: users, previousValue: null, format: 'number' },
        { key: 'trips', label: 'الرحلات', value: trips, previousValue: null, format: 'number' },
        { key: 'bookings', label: 'الحجوزات', value: bookings, previousValue: null, format: 'number' },
        {
          key: 'revenue',
          label: 'الإيراد',
          value: Number(revenueAgg._sum.totalAmount ?? 0),
          previousValue: null,
          format: 'money',
        },
      ],
      series: [],
      tripStatusBreakdown: tripBreakdown.map((t) => ({
        label: String(t.status),
        value: t._count._all,
      })),
      bookingStatusBreakdown: bookingBreakdown.map((b) => ({
        label: String(b.status),
        value: b._count._all,
      })),
      topRoutes: [],
      recentActivity: [],
    });
  }
}
