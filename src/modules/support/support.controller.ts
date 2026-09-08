import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';
import { CurrentUserService } from '../../common/current-user.service';
import { NotFoundException } from '../../common/exceptions/app.exception';
import { PrismaService } from '../../database/prisma/prisma.service';
import { baseFields } from '../../common/utils/entity-defaults';
import { newId, utcNow } from '../../common/utils/date.util';
import { LandingService } from '../landing/landing.service';

@ApiTags('support')
@ApiBearerAuth()
@Controller('api/v1/support')
export class SupportController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get('tickets')
  async tickets(@Query('tab') tab = 'current') {
    const userId = this.currentUser.requireUserId();
    const items = await this.prisma.supportTicket.findMany({
      where: {
        userId,
        isDeleted: false,
        status: tab === 'closed' ? 'closed' : { not: 'closed' },
      },
      orderBy: { createdAt: 'desc' },
    });
    return ApiResponse.ok(items);
  }

  @Post('tickets')
  async create(@Body() body: { subject: string; tripId?: string }) {
    const userId = this.currentUser.requireUserId();
    const ticket = await this.prisma.supportTicket.create({
      data: {
        id: newId(),
        userId,
        subject: body.subject,
        tripId: body.tripId,
        status: 'open',
        ...baseFields(),
      },
    });
    return ApiResponse.ok({ id: ticket.id, status: ticket.status });
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
    return ApiResponse.ok(message);
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
    },
  ) {
    const userId = this.currentUser.requireUserId();
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
        ...baseFields(),
      },
    });
    return ApiResponse.ok({
      id: created.id,
      status: created.status,
    });
  }
}
