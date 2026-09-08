import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';
import { LandingService } from './landing.service';

@ApiTags('landing')
@Controller('api/v1/landing')
export class LandingController {
  constructor(private readonly landing: LandingService) {}

  @Get('route-request-options')
  getRouteOptions(@Headers('accept-language') acceptLanguage?: string) {
    return ApiResponse.ok(this.landing.getRouteOptions(acceptLanguage));
  }

  @Get('popular-routes')
  async popular(@Headers('accept-language') _lang?: string) {
    const routes = await this.landing.getLandingRoutes();
    return ApiResponse.ok(
      routes.slice(0, 6).map((r) => ({
        from: r.from,
        to: r.to,
        requestCount: r.waitlistCount,
      })),
    );
  }

  @Get('routes')
  async routes() {
    return ApiResponse.ok(await this.landing.getLandingRoutes());
  }

  @Get('routes/:id/map')
  async map(@Param('id') id: string) {
    const routes = await this.landing.getLandingRoutes();
    const route = routes.find((r) => r.id === id);
    return ApiResponse.ok({
      id,
      from: route?.from ?? '',
      to: route?.to ?? '',
      source: { label: route?.from ?? '', lat: 0, lng: 0, time: '' },
      destination: { label: route?.to ?? '', lat: 0, lng: 0, time: '' },
      stops: [],
    });
  }

  @Get('config')
  async config() {
    return ApiResponse.ok(await this.landing.getConfig());
  }

  @Post('route-requests')
  async routeRequests(@Body() body: Record<string, unknown>) {
    const result = await this.landing.submitRouteLead({
      phone: String(body.phone ?? ''),
      fromCity: String(body.fromCity ?? ''),
      fromRegion: String(body.fromRegion ?? ''),
      fromTime: body.fromTime as string | undefined,
      toCity: String(body.toCity ?? ''),
      toRegion: String(body.toRegion ?? ''),
      toTime: body.toTime as string | undefined,
      weeklyCount: Number(body.weeklyCount ?? 5),
      usageDays: body.usageDays as string | undefined,
      usageReason: body.usageReason as string | undefined,
    });
    return ApiResponse.ok(result, result.message);
  }

  @Post('waitlist')
  async waitlist(@Body() body: Record<string, unknown>) {
    const result = await this.landing.submitWaitlist({
      phone: String(body.phone ?? ''),
      fullName: body.fullName as string | undefined,
      routeId: (body.routeId as string | undefined) ?? null,
      routeFrom: body.routeFrom as string | undefined,
      routeTo: body.routeTo as string | undefined,
    });
    return ApiResponse.ok(result, result.message);
  }

  @Post('captains')
  async captains(@Body() body: Record<string, unknown>) {
    const result = await this.landing.submitCaptain({
      phone: String(body.phone ?? ''),
      fullName: body.fullName as string | undefined,
      vehicleType: body.vehicleType as string | undefined,
      notes: body.notes as string | undefined,
    });
    return ApiResponse.ok(result, result.message);
  }
}
