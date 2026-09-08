import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { ApiResponse } from '../../common/api-response';
import { DriversService } from './drivers.service';

@ApiTags('drivers')
@ApiBearerAuth()
@Controller('api/v1/drivers')
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Get('me')
  async me() {
    return ApiResponse.ok(await this.drivers.me());
  }

  @Post('me/documents')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 16 * 1024 * 1024 },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body('documentType') documentType?: string,
    @Body('notes') notes?: string,
  ) {
    const doc = await this.drivers.uploadDocument(
      file,
      documentType ?? 'Other',
      notes,
    );
    return ApiResponse.ok(doc, 'تم رفع المرفق');
  }

  @Get('me/trips')
  async trips() {
    return ApiResponse.ok(await this.drivers.myTrips());
  }

  @Post('me/trips/:tripId/start')
  async startTrip(@Param('tripId') tripId: string) {
    const result = await this.drivers.startTrip(tripId);
    return ApiResponse.ok(result, result.message);
  }

  @Post('me/trips/:tripId/complete')
  async completeTrip(@Param('tripId') tripId: string) {
    const result = await this.drivers.completeTrip(tripId);
    return ApiResponse.ok(result, result.message);
  }

  @Get('me/ratings')
  async ratings() {
    return ApiResponse.ok(await this.drivers.ratings());
  }

  @Get('me/rides')
  async rides() {
    return ApiResponse.ok(await this.drivers.myRides());
  }

  @Post('me/rides/:rideId/start')
  async startRide(@Param('rideId') rideId: string) {
    const result = await this.drivers.startRide(rideId);
    return ApiResponse.ok(result, result.message);
  }

  @Post('me/rides/:rideId/complete')
  async completeRide(@Param('rideId') rideId: string) {
    const result = await this.drivers.completeRide(rideId);
    return ApiResponse.ok(result, result.message);
  }

  @Post('me/rides/:rideId/location')
  async location(
    @Param('rideId') rideId: string,
    @Body() body: { latitude: number; longitude: number },
  ) {
    return ApiResponse.ok(
      await this.drivers.updateRideLocation(rideId, body.latitude, body.longitude),
    );
  }

  @Get('me/groups')
  async groups() {
    return ApiResponse.ok(await this.drivers.myGroups());
  }

  @Post('me/groups/:groupId/start')
  async startGroup(@Param('groupId') groupId: string) {
    const result = await this.drivers.startGroup(groupId);
    return ApiResponse.ok(result, result.message);
  }

  @Post('me/groups/:groupId/complete')
  async completeGroup(@Param('groupId') groupId: string) {
    const result = await this.drivers.completeGroup(groupId);
    return ApiResponse.ok(result, result.message);
  }
}
