import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';
import { CaptainRoutesService } from './captain-routes.service';

@ApiTags('captain-routes')
@ApiBearerAuth()
@Controller('api/v1/drivers/me')
export class CaptainRoutesController {
  constructor(private readonly captainRoutes: CaptainRoutesService) {}

  @Get('routes')
  async list() {
    return ApiResponse.ok(await this.captainRoutes.listMine());
  }

  @Get('routes/seat-quote')
  async seatQuote(
    @Query('originLat') originLat?: string,
    @Query('originLng') originLng?: string,
    @Query('destLat') destLat?: string,
    @Query('destLng') destLng?: string,
  ) {
    return ApiResponse.ok(
      await this.captainRoutes.seatQuote({
        originLat: num(originLat),
        originLng: num(originLng),
        destLat: num(destLat),
        destLng: num(destLng),
      }),
    );
  }

  @Post('routes')
  async create(
    @Body()
    body: {
      name?: string;
      description?: string;
      vehicleKind?: string;
      capacity?: number;
      stops: Array<{ name: string; latitude: number; longitude: number }>;
    },
  ) {
    return ApiResponse.ok(await this.captainRoutes.createRoute(body), 'تم حفظ المسار');
  }

  @Patch('routes/:id')
  async update(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      description?: string;
      vehicleKind?: string;
      capacity?: number;
      stops?: Array<{ name: string; latitude: number; longitude: number }>;
    },
  ) {
    return ApiResponse.ok(await this.captainRoutes.updateRoute(id, body), 'تم تحديث المسار');
  }

  @Post('routes/:id/publish')
  async publish(@Param('id') id: string) {
    return ApiResponse.ok(await this.captainRoutes.publish(id), 'تم نشر المسار');
  }

  @Delete('routes/:id')
  async delete(@Param('id') id: string) {
    return ApiResponse.ok(await this.captainRoutes.deleteOwnedRoute(id), 'تم حذف المسار بنجاح');
  }

  @Post('routes/:id/toggle-active')
  async toggleActive(@Param('id') id: string) {
    return ApiResponse.ok(await this.captainRoutes.toggleActive(id), 'تم تحديث حالة المسار');
  }

  @Get('routes/:id/share')
  async share(@Param('id') id: string) {
    return ApiResponse.ok(await this.captainRoutes.share(id));
  }

  @Post('trips')
  async createTrips(
    @Body()
    body: {
      routeId: string;
      scheduledAt: string;
      pricePerSeat: number;
      recurrenceKind?: string;
      daysOfWeek?: number[] | string;
      rangeStart?: string;
      rangeEnd?: string;
      availableSeats?: number;
    },
  ) {
    return ApiResponse.ok(await this.captainRoutes.createTrips(body), 'تم جدولة الرحلات');
  }

  @Post('trips/:id/cancellation-requests')
  async cancel(
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return ApiResponse.ok(
      await this.captainRoutes.requestCancellation(id, body.reason),
      'تم تسجيل طلب الإلغاء',
    );
  }
}

function num(value?: string): number | null {
  if (value == null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
