import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';
import { AdminOnly } from '../../common/decorators/admin-only.decorator';
import { CaptainRoutesService } from '../marketplace/captain-routes.service';

@ApiTags('admin-captain-routes')
@AdminOnly()
@Controller('api/v1/admin/captain-routes')
export class AdminCaptainRoutesController {
  constructor(private readonly captainRoutes: CaptainRoutesService) {}

  @Get('summary')
  async summary() {
    return ApiResponse.ok(await this.captainRoutes.adminSummary());
  }

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('driverId') driverId?: string,
    @Query('vehicleKind') vehicleKind?: string,
    @Query('status') status?: string,
    @Query('scheduleType') scheduleType?: string,
    @Query('date') date?: string,
    @Query('origin') origin?: string,
    @Query('destination') destination?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return ApiResponse.ok(
      await this.captainRoutes.adminList({
        search,
        driverId,
        vehicleKind,
        status,
        scheduleType,
        date,
        origin,
        destination,
        page,
        pageSize,
      }),
    );
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return ApiResponse.ok(await this.captainRoutes.adminGet(id));
  }

  @Post('quote')
  async quote(
    @Body()
    body: {
      driverId: string;
      vehicleKind?: string;
      originLat?: number | null;
      originLng?: number | null;
      destLat?: number | null;
      destLng?: number | null;
      seatPrice?: number | null;
    },
  ) {
    return ApiResponse.ok(await this.captainRoutes.adminQuote(body));
  }

  @Post()
  async create(
    @Body()
    body: {
      driverId: string;
      name?: string;
      description?: string;
      vehicleKind?: string;
      capacity?: number;
      stops: Array<{
        name: string;
        latitude?: number | null;
        longitude?: number | null;
        source?: string | null;
        order?: number | null;
      }>;
      publish?: boolean;
      pricePerSeat?: number;
      scheduledAt?: string;
      scheduleType?: string;
      recurrenceKind?: string;
      daysOfWeek?: number[] | string;
      rangeStart?: string;
      rangeEnd?: string;
    },
  ) {
    return ApiResponse.ok(await this.captainRoutes.adminCreate(body), 'تم حفظ مسار الكابتن');
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body()
    body: {
      driverId?: string;
      name?: string;
      description?: string;
      vehicleKind?: string;
      capacity?: number;
      stops?: Array<{
        name: string;
        latitude?: number | null;
        longitude?: number | null;
        source?: string | null;
        order?: number | null;
      }>;
    },
  ) {
    return ApiResponse.ok(await this.captainRoutes.adminUpdate(id, body), 'تم تحديث مسار الكابتن');
  }

  @Post(':id/publish')
  async publish(@Param('id') id: string) {
    return ApiResponse.ok(await this.captainRoutes.setLifecycle(id, 'publish'), 'تم تفعيل المسار');
  }

  @Post(':id/pause')
  async pause(@Param('id') id: string) {
    return ApiResponse.ok(await this.captainRoutes.setLifecycle(id, 'pause'), 'تم إيقاف المسار');
  }

  @Post(':id/archive')
  async archive(@Param('id') id: string) {
    return ApiResponse.ok(await this.captainRoutes.setLifecycle(id, 'archive'), 'تم إلغاء المسار');
  }

  @Post(':id/trips')
  async createTrips(
    @Param('id') id: string,
    @Body()
    body: {
      scheduledAt: string;
      pricePerSeat: number;
      recurrenceKind?: string;
      scheduleType?: string;
      daysOfWeek?: number[] | string;
      rangeStart?: string;
      rangeEnd?: string;
      availableSeats?: number;
    },
  ) {
    return ApiResponse.ok(await this.captainRoutes.adminCreateTrips(id, body), 'تم توليد الرحلات');
  }
}
