import {
  Body,
  Controller,
  Get,
  Param,
  Query,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { ApiResponse } from '../../common/api-response';
import { DriversService } from './drivers.service';
import { CaptainPaymentsService } from './captain-payments.service';

@ApiTags('drivers')
@ApiBearerAuth()
@Controller('api/v1/drivers')
export class DriversController {
  constructor(
    private readonly drivers: DriversService,
    private readonly payments: CaptainPaymentsService,
  ) {}

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

  @Get('me/home')
  async home() {
    return ApiResponse.ok(await this.drivers.homeBoard());
  }

  @Get('me/trips')
  async trips() {
    return ApiResponse.ok(await this.drivers.myTrips());
  }

  @Get('me/trips/history')
  async tripHistory(
    @Query('bucket') bucket?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('date') date?: string,
  ) {
    return ApiResponse.ok(
      await this.drivers.tripHistory({
        bucket,
        page: Number(page),
        pageSize: Number(pageSize),
        kind,
        status,
        date,
      }),
    );
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

  @Post('me/trips/:tripId/cancel')
  async cancelTrip(
    @Param('tripId') tripId: string,
    @Body() body?: { reason?: string },
  ) {
    const result = await this.drivers.cancelTrip(tripId, body?.reason);
    return ApiResponse.ok(result, result.message);
  }

  @Get('me/ratings')
  async ratings() {
    return ApiResponse.ok(await this.drivers.ratings());
  }

  @Get('me/payments')
  async paymentsSummary() {
    return ApiResponse.ok(await this.payments.summary());
  }

  @Post('me/payments')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 4 * 1024 * 1024 },
    }),
  )
  async submitPayment(
    @UploadedFile() file: Express.Multer.File,
    @Body('senderPhone') senderPhone?: string,
  ) {
    return ApiResponse.ok(
      await this.payments.submit(senderPhone, file),
      'تم إرسال التحويل وبانتظار المراجعة',
    );
  }

  @Get(':id/profile')
  async profile(@Param('id') id: string) {
    return ApiResponse.ok(await this.drivers.publicProfile(id));
  }

  @Post(':id/reviews')
  async review(
    @Param('id') id: string,
    @Body() body: { tripId?: string; stars?: number; comment?: string },
  ) {
    return ApiResponse.ok(
      await this.drivers.submitReview(id, body),
      'تم حفظ التقييم',
    );
  }

  @Get('me/rides')
  async rides() {
    return ApiResponse.ok(await this.drivers.myRides());
  }

    @Get('me/pending-rides')
  async pendingRides(
    @Query('latitude') latitude?: string,
    @Query('longitude') longitude?: string,
    @Query('radiusKm') radiusKm?: string,
  ) {
    return ApiResponse.ok(
      await this.drivers.pendingNearbyRides(
        latitude ? Number(latitude) : undefined,
        longitude ? Number(longitude) : undefined,
        radiusKm ? Number(radiusKm) : undefined,
      ),
    );
  }

  @Post('me/availability')
  async availability(@Body() body?: { online?: boolean }) {
    return ApiResponse.ok(
      await this.drivers.setAvailability(body?.online === true),
      body?.online === true ? 'أنت متاح الآن' : 'أنت غير متاح',
    );
  }

  @Post('me/rides/:rideId/accept')
  async acceptRide(@Param('rideId') rideId: string) {
    const result = await this.drivers.acceptRide(rideId);
    return ApiResponse.ok(result, result.message);
  }

  @Post('me/rides/:rideId/reject')
  async rejectRide(@Param('rideId') rideId: string) {
    const result = await this.drivers.rejectRide(rideId);
    return ApiResponse.ok(result, result.message);
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

  @Post('me/rides/:rideId/collect')
  async collectRide(@Param('rideId') rideId: string) {
    const result = await this.drivers.confirmRideCash(rideId);
    return ApiResponse.ok(result, 'تم تحصيل الرسوم');
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

  @Post('me/rides/:rideId/arrive')
  async arriveRide(@Param('rideId') rideId: string) {
    const result = await this.drivers.arriveRide(rideId);
    return ApiResponse.ok(result, result.message);
  }

  @Post('me/rides/:rideId/cancel')
  async cancelRide(
    @Param('rideId') rideId: string,
    @Body() body?: { reason?: string },
  ) {
    const result = await this.drivers.cancelRideByDriver(rideId, body?.reason);
    return ApiResponse.ok(result, result.message);
  }

  @Post('me/rides/:rideId/terminate')
  async terminateRide(
    @Param('rideId') rideId: string,
    @Body() body: { action: 'request' | 'accept' | 'reject'; reason?: string; latitude?: number; longitude?: number },
  ) {
    const result = await this.drivers.handleEarlyTermination(
      rideId,
      body.action,
      'driver',
      body.reason,
      body.latitude,
      body.longitude,
    );
    return ApiResponse.ok(result, result.message);
  }

}