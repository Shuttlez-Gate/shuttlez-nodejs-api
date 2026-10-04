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
    return ApiResponse.ok(loc ?? { lat: null, lng: null, name: null });
  }

  @Get('reverse')
  async reverse(@Query('lat') latRaw?: string, @Query('lng') lngRaw?: string) {
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return ApiResponse.ok({ lat: null, lng: null, name: null });
    }
    return ApiResponse.ok(
      (await this.places.reverse(lat, lng)) ?? { lat, lng, name: null },
    );
  }

  /** Road route for the rider map. The browser cannot call Google Directions (CORS). */
  @Get('directions')
  async directions(
    @Query('originLat') originLatRaw?: string,
    @Query('originLng') originLngRaw?: string,
    @Query('destLat') destLatRaw?: string,
    @Query('destLng') destLngRaw?: string,
    @Query('waypoints') waypointsRaw?: string,
  ) {
    const originLat = Number(originLatRaw);
    const originLng = Number(originLngRaw);
    const destLat = Number(destLatRaw);
    const destLng = Number(destLngRaw);
    if (
      !Number.isFinite(originLat) ||
      !Number.isFinite(originLng) ||
      !Number.isFinite(destLat) ||
      !Number.isFinite(destLng)
    ) {
      return ApiResponse.ok({ points: [], durationSeconds: 0, distanceMeters: 0 });
    }
    const waypoints = (waypointsRaw ?? '')
      .split('|')
      .map((token) => token.trim())
      .filter(Boolean)
      .map((token) => {
        const [latRaw, lngRaw] = token.split(',');
        return { lat: Number(latRaw), lng: Number(lngRaw) };
      })
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
    const route = await this.places.drivingRoute({
      originLat,
      originLng,
      destLat,
      destLng,
      waypoints,
    });
    return ApiResponse.ok(route);
  }
}
