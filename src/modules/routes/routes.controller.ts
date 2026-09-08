import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';
import { AppException, NotFoundException } from '../../common/exceptions/app.exception';
import { ErrorCodes } from '../../common/error-codes';
import { PrismaService } from '../../database/prisma/prisma.service';
import { splitRouteName } from '../landing/landing.service';

const badgePalette = [
  [uncheckedInt(0xff95feb3), uncheckedInt(0xff42ff78)],
  [uncheckedInt(0xff94f3fe), uncheckedInt(0xff30e9ff)],
  [uncheckedInt(0xffffd5d1), uncheckedInt(0xffff7a6e)],
];

@ApiTags('routes')
@Controller('api/v1/routes')
export class RoutesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const routes = await this.prisma.route.findMany({
      where: { isActive: true, isDeleted: false },
      orderBy: { name: 'asc' },
      include: { stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } } },
    });
    return ApiResponse.ok(
      routes.map((route, i) => {
        const { from, to } = splitRouteName(route.name);
        const palette = badgePalette[i % badgePalette.length];
        const firstStop = route.stops[0];
        return {
          id: route.id,
          from,
          to,
          stopsCount: route.stops.length,
          nearestStop: 'أقرب نقطة التقاء - 10دق',
          nearestStreet: firstStop?.name ?? route.description ?? from,
          busPlate: 'B-YT-5904',
          badgeColorStart: palette[0],
          badgeColorEnd: palette[1],
        };
      }),
    );
  }

  @Get(':id/timeline')
  async timeline(@Param('id') id: string) {
    const route = await this.prisma.route.findFirst({
      where: { id, isActive: true, isDeleted: false },
      include: { stops: { where: { isDeleted: false }, orderBy: { order: 'asc' } } },
    });
    if (!route) {
      throw new NotFoundException('المسار غير موجود');
    }
    const { from, to } = splitRouteName(route.name);
    const stops = [
      { kind: 'start', title: from, subtitle: '', badge: null as string | null },
      ...route.stops.map((s) => ({
        kind: 'stop',
        title: s.name,
        subtitle: '',
        badge: null as string | null,
      })),
      { kind: 'end', title: to, subtitle: '', badge: null as string | null },
    ];
    return ApiResponse.ok({ routeId: route.id, stops });
  }
}

@ApiTags('customer-trips')
@Controller('api/v1/customer-trips')
export class CustomerTripsController {
  @Post()
  create() {
    throw new AppException(
      'هذا المسار متوقف. حجز الشاتل عبر /api/v1/bookings فقط. منتج Ride يحتاج عقد تسعير وتشغيل منفصل.',
      410,
      ErrorCodes.CustomerTripsDeprecated,
    );
  }
}

function uncheckedInt(value: number): number {
  return value | 0;
}
