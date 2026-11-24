import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';
import { SocketIoReadinessService } from '../realtime/socket-io-readiness.service';

@ApiTags('health')
@Controller('api/v1/health')
export class HealthController {
  constructor(private readonly realtimeReadiness: SocketIoReadinessService) {}

  @Get()
  get() {
    return ApiResponse.ok({
      status: 'healthy',
      service: 'Shuttlez.API',
      timestamp: new Date().toISOString(),
    });
  }

  @Get('ready')
  getReadiness(@Res({ passthrough: true }) response: Response) {
    const ready = this.realtimeReadiness.isReady;
    response.status(ready ? 200 : 503);
    return ready
      ? ApiResponse.ok({ status: 'ready', realtime: this.realtimeReadiness.status })
      : ApiResponse.fail('Service is not ready', 'SERVICE_NOT_READY');
  }
}
