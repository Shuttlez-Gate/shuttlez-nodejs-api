import { Body, Controller, Delete, Get, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';
import { AdminOnly } from '../../common/decorators/admin-only.decorator';
import { RouteDemandService } from './route-demand/route-demand.service';

@ApiTags('admin-route-demand')
@AdminOnly()
@Controller('api/v1/admin/route-demand')
export class AdminRouteDemandController {
  constructor(private readonly demand: RouteDemandService) {}

  @Get('summary')
  async summary() {
    return ApiResponse.ok(await this.demand.summary());
  }

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('vehicleType') vehicleType?: string,
    @Query('priority') priority?: string,
    @Query('status') status?: string,
    @Query('routeType') routeType?: string,
    @Query('routeCategory') routeCategory?: string,
    @Query('createdFrom') createdFrom?: string,
    @Query('createdTo') createdTo?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('launchStatus') launchStatus?: string,
    @Query('pricingAvailable') pricingAvailable?: string,
    @Query('readyToLaunch') readyToLaunch?: string,
  ) {
    return ApiResponse.ok(
      await this.demand.list({
        search,
        from,
        to,
        vehicleType,
        priority,
        status,
        routeType,
        routeCategory,
        createdFrom,
        createdTo,
        page,
        pageSize,
        launchStatus,
        pricingAvailable,
        readyToLaunch,
      }),
    );
  }

  @Get('export')
  async export(
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('vehicleType') vehicleType?: string,
    @Query('priority') priority?: string,
    @Query('status') status?: string,
    @Query('routeType') routeType?: string,
    @Query('routeCategory') routeCategory?: string,
    @Query('createdFrom') createdFrom?: string,
    @Query('createdTo') createdTo?: string,
    @Query('launchStatus') launchStatus?: string,
    @Query('pricingAvailable') pricingAvailable?: string,
    @Query('readyToLaunch') readyToLaunch?: string,
  ) {
    return ApiResponse.ok(
      await this.demand.export({
        search,
        from,
        to,
        vehicleType,
        priority,
        status,
        routeType,
        routeCategory,
        createdFrom,
        createdTo,
        launchStatus,
        pricingAvailable,
        readyToLaunch,
      }),
    );
  }

  @Get('launch-plan')
  async launchPlan(
    @Query('routeKey') routeKey?: string,
    @Query('vehicleType') vehicleType?: string,
    @Query('launchStatus') launchStatus?: string,
    @Query('readyToLaunch') readyToLaunch?: string,
    @Query('pricingAvailable') pricingAvailable?: string,
    @Query('search') search?: string,
  ) {
    return ApiResponse.ok(
      await this.demand.launchPlan({
        routeKey,
        vehicleType,
        launchStatus,
        readyToLaunch,
        pricingAvailable,
        search,
      }),
    );
  }

  @Get('vehicle-capacities')
  async capacities() {
    return ApiResponse.ok(await this.demand.vehicleCapacities());
  }

  @Get('details')
  async details(@Query('routeKey') routeKey: string) {
    return ApiResponse.ok(await this.demand.details(routeKey));
  }

  @Get('passengers')
  async passengers(@Query('routeKey') routeKey: string) {
    return ApiResponse.ok(await this.demand.passengers(routeKey));
  }

  @Patch('status')
  async updateStatus(
    @Query('routeKey') routeKey: string,
    @Body() body: { status: string; assignedDriverId?: string | null },
  ) {
    return ApiResponse.ok(await this.demand.updateStatus(routeKey, body), 'تم تحديث حالة الخط');
  }

  @Put('map-route')
  async mapRoute(
    @Query('routeKey') routeKey: string,
    @Body() body: { routeId: string },
  ) {
    return ApiResponse.ok(
      await this.demand.mapRoute(routeKey, body.routeId),
      'تم ربط الطلب بالمسار الرسمي',
    );
  }

  @Delete('map-route')
  async unmap(@Query('routeKey') routeKey: string) {
    return ApiResponse.ok(await this.demand.unmapRoute(routeKey), 'تم إزالة ربط المسار');
  }

  @Post('launch')
  async launch(
    @Query('routeKey') routeKey: string,
    @Body() body: { scheduledAt: string; driverId?: string | null; vehicleId?: string | null },
  ) {
    return ApiResponse.ok(await this.demand.launch(routeKey, body), 'تم تشغيل الخط بنجاح');
  }
}
