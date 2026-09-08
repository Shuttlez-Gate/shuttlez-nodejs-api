import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { AdminOnlyGuard } from '../guards/admin-only.guard';

export function AdminOnly() {
  return applyDecorators(UseGuards(AdminOnlyGuard), ApiBearerAuth());
}
