import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';
import { CurrentUserService } from '../../common/current-user.service';
import { AppException, NotFoundException } from '../../common/exceptions/app.exception';
import { PrismaService } from '../../database/prisma/prisma.service';
import { baseFields } from '../../common/utils/entity-defaults';
import { newId, utcNow } from '../../common/utils/date.util';
import { LandingService } from '../landing/landing.service';
import { SupportChatGateway } from '../realtime/realtime.gateway';

@ApiTags('support')
@ApiBearerAuth()
@Controller('api/v1/support')
export class SupportController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
    private readonly supportChat: SupportChatGateway,
  ) {}

  @Get('tickets')
  async tickets(@Query('tab') tab = 'current') {
    const userId = this.currentUser.requireUserId();
    const items = await this.prisma.supportTicket.findMany({
      where: {
        userId,
        isDeleted: false,
        status:
          tab === 'closed' || tab === 'completed' ? 'closed' : { not: 'closed' },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        trip: {
          include: {
            route: {
              include: {
                stops: {
                  where: { isDeleted: false },
                  orderBy: { order: 'asc' },
                },
              },
            },
            bookings: {
              where: { userId, isDeleted: false },
              orderBy: { createdAt: 'desc' },
              take: 1,
              include: { originStop: true, destinationStop: true },
            },
          },
        },
      },
    });
    return ApiResponse.ok(items.map((item) => this.toRiderTicket(item)));
  }

  @Post('tickets')
  async create(
    @Body()
    body: { subject?: string; tripId?: string; initialMessage?: string },
  ) {
    const userId = this.currentUser.requireUserId();
    const subject = (body.subject ?? body.initialMessage ?? 'بلاغ عن رحلة').trim();
    if (!subject) {
      throw new AppException('عنوان البلاغ مطلوب', 400);
    }
    const tripId = await this.existingTripId(body.tripId);
    const ticket = await this.prisma.supportTicket.create({
      data: {
        id: newId(),
        userId,
        subject,
        ...(tripId ? { tripId } : {}),
        status: 'open',
        ...baseFields(),
      },
    });
    return ApiResponse.ok({
      id: ticket.id,
      ticketId: ticket.id,
      status: ticket.status,
    });
  }

  @Get('tickets/:id/messages')
  async messages(@Param('id') id: string) {
    const userId = this.currentUser.requireUserId();
    const ticket = await this.ownedTicket(id, userId);
    const items = await this.prisma.supportMessage.findMany({
      where: { ticketId: ticket.id, isDeleted: false },
      orderBy: { createdAt: 'asc' },
    });
    return ApiResponse.ok(items);
  }

  @Post('tickets/:id/messages')
  async send(
    @Param('id') id: string,
    @Body() body: { content: string },
  ) {
    const userId = this.currentUser.requireUserId();
    const ticket = await this.ownedTicket(id, userId);
    const message = await this.prisma.supportMessage.create({
      data: {
        id: newId(),
        ticketId: ticket.id,
        senderId: userId,
        isFromSupport: false,
        content: body.content,
        ...baseFields(),
      },
    });
    await this.prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { updatedAt: utcNow() },
    });
    this.supportChat.publish({
      id: message.id,
      ticketId: message.ticketId,
      isFromSupport: message.isFromSupport,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    });
    return ApiResponse.ok(message);
  }

  private toRiderTicket(item: {
    id: string;
    userId: string;
    tripId: string | null;
    subject: string;
    status: string;
    closedAt: Date | null;
    createdAt: Date;
    updatedAt: Date | null;
    isDeleted: boolean;
    trip: {
      id: string;
      status: number;
      scheduledAt: Date;
      pricePerSeat: { toString(): string };
      referenceCode: string | null;
      route: {
        name: string;
        ownerType: number;
        vehicleKind: string | null;
        startLatitude: number;
        startLongitude: number;
        endLatitude: number;
        endLongitude: number;
        stops: { name: string }[];
      };
      bookings: {
        seatCount: number;
        totalAmount: { toString(): string };
        paymentMethod: string;
        referenceCode: string | null;
        vehicleKind: string | null;
        originStop: { name: string } | null;
        destinationStop: { name: string } | null;
      }[];
    } | null;
  }) {
    const trip = item.trip;
    const booking = trip?.bookings[0];
    const stops = trip?.route.stops ?? [];
    const from =
      booking?.originStop?.name?.trim() || stops[0]?.name?.trim() || '';
    const to =
      booking?.destinationStop?.name?.trim() ||
      stops[stops.length - 1]?.name?.trim() ||
      '';
    const vehicle = this.vehiclePresentation(
      booking?.vehicleKind || trip?.route.vehicleKind,
      trip?.route.ownerType ?? 0,
      trip?.route.name ?? '',
    );
    const seats = booking?.seatCount;
    const amount = booking ? Number(booking.totalAmount) : NaN;

    return {
      id: item.id,
      userId: item.userId,
      tripId: item.tripId,
      subject: item.subject,
      status: item.status,
      closedAt: item.closedAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isDeleted: item.isDeleted,
      seatsLabel:
        seats == null ? undefined : seats === 1 ? '1 مقعد' : `${seats} مقاعد`,
      paymentLabel:
        booking == null || !Number.isFinite(amount)
          ? undefined
          : `${this.money(amount)} ج.م - ${this.payMethod(booking.paymentMethod)}`,
      trip: trip
        ? {
            id: trip.id,
            from,
            to,
            vehicleType: vehicle.vehicleType,
            vehicleAssetKey: vehicle.vehicleAssetKey,
            dateTimeLabel: this.cairoLabel(trip.scheduledAt),
            tripDate: trip.scheduledAt.toISOString(),
            status: 'upcoming',
            referenceCode: booking?.referenceCode || trip.referenceCode,
            startLatitude: trip.route.startLatitude,
            startLongitude: trip.route.startLongitude,
            endLatitude: trip.route.endLatitude,
            endLongitude: trip.route.endLongitude,
          }
        : null,
    };
  }

  private vehiclePresentation(
    kind: string | null | undefined,
    ownerType: number,
    routeName: string,
  ) {
    const token = (kind ?? '').trim().toLowerCase();
    const asset =
      token === 'bus' || token === 'coach'
        ? 'bus'
        : token === 'minibus' || token === 'microbus' || token === 'micro'
          ? 'minibus'
          : 'car';
    if (ownerType === 1 && routeName.trim()) {
      return { vehicleType: routeName.trim(), vehicleAssetKey: asset };
    }
    if (asset === 'minibus') {
      return {
        vehicleType: 'سيارة مشوار خاصة - ميني باص',
        vehicleAssetKey: 'minibus',
      };
    }
    if (asset === 'bus') {
      return { vehicleType: 'اتوبيس شاتيل', vehicleAssetKey: 'bus' };
    }
    return { vehicleType: 'عربية شاتيل', vehicleAssetKey: 'car' };
  }

  private money(value: number) {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }

  private payMethod(raw: string) {
    const value = raw.trim().toLowerCase();
    if (value === 'cash' || value === 'cod') return 'نقدا';
    if (value === 'wallet') return 'محفظة';
    if (value === 'card') return 'بطاقة';
    if (value === 'subscription') return 'باقة';
    return 'نقدا';
  }

  private cairoLabel(date: Date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Cairo',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const pick = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? '';
    const weekdays: Record<string, string> = {
      Sun: 'الأحد',
      Mon: 'الإثنين',
      Tue: 'الثلاثاء',
      Wed: 'الأربعاء',
      Thu: 'الخميس',
      Fri: 'الجمعة',
      Sat: 'السبت',
    };
    const day = weekdays[pick('weekday')] ?? '';
    return `${day} ${pick('year')}/${pick('month')}/${pick('day')} - ${pick('hour')}:${pick('minute')}`;
  }

  private async existingTripId(raw?: string) {
    const tripId = raw?.trim();
    if (!tripId) return undefined;
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, isDeleted: false },
      select: { id: true },
    });
    return trip?.id;
  }

  private async ownedTicket(id: string, userId: string) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id, userId, isDeleted: false },
    });
    if (!ticket) {
      throw new NotFoundException('التذكرة غير موجودة');
    }
    return ticket;
  }
}

@ApiTags('route-requests')
@Controller('api/v1/route-requests')
export class RouteRequestsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
    private readonly landing: LandingService,
  ) {}

  @Get('options')
  options(@Headers('accept-language') language?: string) {
    return ApiResponse.ok(this.landing.getRouteOptions(language));
  }

  @Post()
  @ApiBearerAuth()
  async create(
    @Body()
    body: {
      fromAddress: string;
      toAddress: string;
      fromLatitude: number;
      fromLongitude: number;
      toLatitude: number;
      toLongitude: number;
      notes?: string;
      preferredVehicleType?: string;
      kind?: string;
    },
  ) {
    const userId = this.currentUser.requireUserId();
    const kind = (body.kind ?? 'request').trim().toLowerCase();
    if (kind !== 'notify' && kind !== 'request') {
      throw new AppException('نوع الطلب غير صالح', 400);
    }
    const created = await this.prisma.routeRequest.create({
      data: {
        id: newId(),
        userId,
        fromAddress: body.fromAddress,
        toAddress: body.toAddress,
        fromLatitude: body.fromLatitude,
        fromLongitude: body.fromLongitude,
        toLatitude: body.toLatitude,
        toLongitude: body.toLongitude,
        status: 'pending',
        notes: body.notes,
        preferredVehicleType: body.preferredVehicleType ?? '',
        kind,
        ...baseFields(),
      },
    });
    return ApiResponse.ok({
      id: created.id,
      status: created.status,
      kind: created.kind,
    });
  }
}
