import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type PlaceSuggestionDto = {
  placeId: string;
  description: string;
  subtitle?: string | null;
};

@Injectable()
export class PlacesService {
  constructor(private readonly config: ConfigService) {}

  private apiKey(): string {
    const key =
      this.config.get<string>('GOOGLE_MAPS_API_KEY')?.trim() ||
      this.config.get<string>('GOOGLE_PLACES_API_KEY')?.trim() ||
      '';
    if (!key) {
      throw new ServiceUnavailableException(
        'GOOGLE_MAPS_API_KEY is not configured',
      );
    }
    return key;
  }

  async autocomplete(input: {
    query: string;
    language?: string;
    lat?: number;
    lng?: number;
  }): Promise<PlaceSuggestionDto[]> {
    const q = input.query.trim();
    if (q.length < 2) return [];

    const params = new URLSearchParams({
      input: q,
      key: this.apiKey(),
      language: input.language?.trim() || 'ar',
      components: 'country:eg',
      region: 'eg',
    });
    if (
      typeof input.lat === 'number' &&
      typeof input.lng === 'number' &&
      Number.isFinite(input.lat) &&
      Number.isFinite(input.lng)
    ) {
      params.set('location', `${input.lat},${input.lng}`);
      params.set('radius', '50000');
    }

    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      status?: string;
      error_message?: string;
      predictions?: Array<Record<string, unknown>>;
    };

    const status = data.status ?? '';
    if (status === 'ZERO_RESULTS') return [];
    if (status === 'REQUEST_DENIED' || status === 'OVER_QUERY_LIMIT') {
      throw new ServiceUnavailableException(
        data.error_message || `Places autocomplete denied (${status})`,
      );
    }
    if (status && status !== 'OK') {
      throw new ServiceUnavailableException(
        data.error_message || `Places autocomplete failed (${status})`,
      );
    }

    return (data.predictions ?? [])
      .map((item): PlaceSuggestionDto | null => {
        const placeId = String(item.place_id ?? '');
        if (!placeId) return null;
        const description = String(item.description ?? '');
        const structured = item.structured_formatting as
          | Record<string, unknown>
          | undefined;
        const subtitle =
          structured?.secondary_text != null
            ? String(structured.secondary_text)
            : null;
        return {
          placeId,
          description,
          subtitle,
        };
      })
      .filter((x): x is PlaceSuggestionDto => x != null);
  }

  async details(placeId: string): Promise<{
    lat: number;
    lng: number;
    name: string | null;
  } | null> {
    const id = placeId.trim();
    if (!id) return null;

    const params = new URLSearchParams({
      place_id: id,
      fields: 'geometry,name,formatted_address',
      key: this.apiKey(),
      language: 'ar',
    });
    const url = `https://maps.googleapis.com/maps/api/place/details/json?${params}`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      status?: string;
      result?: {
        name?: string;
        formatted_address?: string;
        geometry?: { location?: { lat?: number; lng?: number } };
      };
    };
    if (data.status && data.status !== 'OK') return null;
    const loc = data.result?.geometry?.location;
    const lat = loc?.lat;
    const lng = loc?.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    return {
      lat,
      lng,
      name: data.result?.name || data.result?.formatted_address || null,
    };
  }

  async reverse(lat: number, lng: number): Promise<{
    lat: number;
    lng: number;
    name: string | null;
  } | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const params = new URLSearchParams({
      latlng: `${lat},${lng}`,
      key: this.apiKey(),
      language: 'ar',
    });
    const url = `https://maps.googleapis.com/maps/api/geocode/json?${params}`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      status?: string;
      results?: Array<{
        formatted_address?: string;
        address_components?: Array<{ short_name?: string; types?: string[] }>;
      }>;
    };
    if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      return { lat, lng, name: null };
    }
    const first = data.results?.[0];
    const neighborhood = first?.address_components?.find((c) =>
      (c.types ?? []).some((t) =>
        ['neighborhood', 'sublocality', 'sublocality_level_1', 'locality', 'route'].includes(t),
      ),
    )?.short_name;
    return {
      lat,
      lng,
      name: neighborhood || first?.formatted_address || null,
    };
  }

  async drivingRoute(input: {
    originLat: number;
    originLng: number;
    destLat: number;
    destLng: number;
    waypoints?: Array<{ lat: number; lng: number }>;
  }): Promise<{
    points: Array<{ latitude: number; longitude: number }>;
    durationSeconds: number;
    distanceMeters: number;
  }> {
    const params = new URLSearchParams({
      origin: `${input.originLat},${input.originLng}`,
      destination: `${input.destLat},${input.destLng}`,
      mode: 'driving',
      key: this.apiKey(),
    });
    const waypoints = (input.waypoints ?? []).filter(
      (point) => Number.isFinite(point.lat) && Number.isFinite(point.lng),
    );
    if (waypoints.length > 0) {
      params.set('waypoints', waypoints.map((point) => `${point.lat},${point.lng}`).join('|'));
    }
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/directions/json?${params}`,
    );
    const data = (await res.json()) as {
      status?: string;
      error_message?: string;
      routes?: Array<{
        overview_polyline?: { points?: string };
        legs?: Array<{
          duration?: { value?: number };
          distance?: { value?: number };
          steps?: Array<{ polyline?: { points?: string } }>;
        }>;
      }>;
    };
    const status = data.status ?? '';
    if (status === 'ZERO_RESULTS') {
      return { points: [], durationSeconds: 0, distanceMeters: 0 };
    }
    if (status && status !== 'OK') {
      throw new ServiceUnavailableException(
        data.error_message || `Directions failed (${status})`,
      );
    }
    const route = data.routes?.[0];
    const detailed = decodeRouteSteps(route?.legs);
    const points =
      detailed.length >= 2
        ? detailed
        : decodePolyline(route?.overview_polyline?.points ?? '');
    const durationSeconds = (route?.legs ?? []).reduce(
      (sum, leg) => sum + (leg.duration?.value ?? 0),
      0,
    );
    const distanceMeters = (route?.legs ?? []).reduce(
      (sum, leg) => sum + (leg.distance?.value ?? 0),
      0,
    );
    return { points, durationSeconds, distanceMeters };
  }
}

function decodeRouteSteps(
  legs?: Array<{ steps?: Array<{ polyline?: { points?: string } }> }>,
): Array<{ latitude: number; longitude: number }> {
  const points: Array<{ latitude: number; longitude: number }> = [];
  for (const leg of legs ?? []) {
    for (const step of leg.steps ?? []) {
      const decoded = decodePolyline(step.polyline?.points ?? '');
      if (decoded.length === 0) continue;
      if (points.length > 0) points.push(...decoded.slice(1));
      else points.push(...decoded);
    }
  }
  return points;
}

function decodePolyline(
  encoded: string,
): Array<{ latitude: number; longitude: number }> {
  const points: Array<{ latitude: number; longitude: number }> = [];
  if (!encoded) return points;
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return points;
}
