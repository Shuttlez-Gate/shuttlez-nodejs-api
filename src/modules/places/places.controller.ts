import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';
import { PlacesService } from './places.service';

@ApiTags('places')
@Controller('api/v1/places')
export class PlacesController {
  constructor(private readonly places: PlacesService) {}

  /** Rider / web autocomplete proxy — avoids browser CORS to Google. */
  @Get('autocomplete')
  async autocomplete(
    @Query('q') q?: string,
    @Query('query') query?: string,
    @Query('language') language?: string,
    @Query('lat') latRaw?: string,
    @Query('lng') lngRaw?: string,
  ) {
    const input = (q ?? query ?? '').trim();
    const lat = latRaw != null ? Number(latRaw) : undefined;
    const lng = lngRaw != null ? Number(lngRaw) : undefined;
    const items = await this.places.autocomplete({
      query: input,
      language,
      lat: Number.isFinite(lat) ? lat : undefined,
      lng: Number.isFinite(lng) ? lng : undefined,
    });
    return ApiResponse.ok(items);
  }

  @Get('details')
  async details(@Query('placeId') placeId?: string) {
    const loc = await this.places.details(placeId ?? '');
    return ApiResponse.ok(loc);
  }
}
