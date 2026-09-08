import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';
import { RidesService } from './rides.service';

@ApiTags('rides')
@ApiBearerAuth()
@Controller('api/v1/rides')
export class RidesController {
  constructor(private readonly rides: RidesService) {}

  @Get('quote')
  async quote(
    @Query('fromZoneKey') fromZoneKey?: string,
    @Query('toZoneKey') toZoneKey?: string,
    @Query('pickupLatitude') pickupLatitude?: string,
    @Query('pickupLongitude') pickupLongitude?: string,
    @Query('destinationLatitude') destinationLatitude?: string,
    @Query('destinationLongitude') destinationLongitude?: string,
  ) {
    return ApiResponse.ok(
      await this.rides.quote({
        fromZoneKey,
        toZoneKey,
        pickupLatitude: num(pickupLatitude),
        pickupLongitude: num(pickupLongitude),
        destinationLatitude: num(destinationLatitude),
        destinationLongitude: num(destinationLongitude),
      }),
    );
  }

  @Get('fare-options')
  async fareOptions() {
    return ApiResponse.ok(await this.rides.fareOptions());
  }

  @Post()
  async create(
    @Body()
    body: {
      pickupLatitude: number;
      pickupLongitude: number;
      destinationLatitude: number;
      destinationLongitude: number;
      pickupAddress?: string;
      destinationAddress?: string;
      fromZoneKey?: string;
      toZoneKey?: string;
      paymentMethod?: string;
    },
  ) {
    const ride = await this.rides.create(body);
    return ApiResponse.ok(ride, 'تم إنشاء طلب المشوار — الدفع نقدًا للكابتن');
  }

  @Get('me')
  async me() {
    return ApiResponse.ok(await this.rides.mine());
  }

  @Get(':rideId')
  async byId(@Param('rideId') rideId: string) {
    return ApiResponse.ok(await this.rides.byId(rideId));
  }

  @Post(':rideId/cancel')
  async cancel(@Param('rideId') rideId: string) {
    return ApiResponse.ok(await this.rides.cancel(rideId), 'تم إلغاء المشوار');
  }
}

function num(value?: string): number | undefined {
  if (value == null || value === '') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
