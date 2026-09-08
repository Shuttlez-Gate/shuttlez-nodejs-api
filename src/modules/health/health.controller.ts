import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';

@ApiTags('health')
@Controller('api/v1/health')
export class HealthController {
  @Get()
  get() {
    return ApiResponse.ok({
      status: 'healthy',
      service: 'Shuttlez.API',
      timestamp: new Date().toISOString(),
    });
  }
}
