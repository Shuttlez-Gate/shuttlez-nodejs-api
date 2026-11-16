import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';
import { AdminOnly } from '../../common/decorators/admin-only.decorator';
import { CaptainPaymentsService } from '../drivers/captain-payments.service';

@ApiTags('admin-commission-payments')
@AdminOnly()
@Controller('api/v1/admin/commission-payments')
export class AdminCommissionPaymentsController {
  constructor(private readonly payments: CaptainPaymentsService) {}

  @Get()
  async list() {
    return ApiResponse.ok(await this.payments.adminList());
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return ApiResponse.ok(await this.payments.adminDetail(id));
  }

  @Post(':id/confirm')
  async confirm(@Param('id') id: string) {
    return ApiResponse.ok(await this.payments.adminConfirm(id), 'تم تأكيد الدفع');
  }
}
