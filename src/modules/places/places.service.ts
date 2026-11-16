import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type PlaceSuggestionDto = {
  placeId: string;
  description: string;
  subtitle?: string | null;
  lat?: number | null;
  lng?: number | null;
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

  private hasGoogleKey(): boolean {
    return Boolean(
      this.config.get<string>('GOOGLE_MAPS_API_KEY')?.trim() ||
        this.config.get<string>('GOOGLE_PLACES_API_KEY')?.trim(),
    );
  }

  async autocomplete(input: {
    query: string;
    language?: string;
    lat?: number;
    lng?: number;
  }): Promise<PlaceSuggestionDto[]> {
    const q = input.query.trim();
    if (q.length < 2) return [];

    if (this.hasGoogleKey()) {
      try {
        const google = await this.googleAutocomplete(input);
        if (google.length > 0) return google;
      } catch {
        // Fall through to OpenStreetMap so the admin can still pick a place.
      }
    }
    return this.nominatimAutocomplete(q);
  }

  private async googleAutocomplete(input: {
    query: string;
    language?: string;
    lat?: number;
    lng?: number;
  }): Promise<PlaceSuggestionDto[]> {
    const q = input.query.trim();
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

  private async nominatimAutocomplete(query: string): Promise<PlaceSuggestionDto[]> {
    const params = new URLSearchParams({
      format: 'jsonv2',
      q: query,
      countrycodes: 'eg',
      limit: '8',
      'accept-language': 'ar',
    });
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'User-Agent': 'ShuttlezAdmin/1.0 (admin.shuttlez.org)' },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{
      place_id?: number;
      display_name?: string;
      name?: string;
      lat?: string;
      lon?: string;
    }>;
    return (data ?? [])
      .map((item): PlaceSuggestionDto | null => {
        const lat = Number(item.lat);
        const lng = Number(item.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return {
          placeId: `nominatim:${item.place_id ?? `${lat},${lng}`}`,
          description: item.name || item.display_name || query,
          subtitle: item.display_name ?? null,
          lat,
          lng,
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
    if (id.startsWith('nominatim:')) {
      return this.nominatimDetails(id.substring('nominatim:'.length));
    }
    if (id.startsWith('photon:') || id.startsWith('local:')) {
      return parseLatLngId(id.substring(id.indexOf(':') + 1));
    }
    if (!this.hasGoogleKey()) return null;

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
    if (this.hasGoogleKey()) {
      try {
        const google = await this.googleReverse(lat, lng);
        if (google?.name) return google;
      } catch {
        // Fall through to OpenStreetMap.
      }
    }
    return this.nominatimReverse(lat, lng);
  }

  private async googleReverse(
    lat: number,
    lng: number,
  ): Promise<{ lat: number; lng: number; name: string | null } | null> {
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

  private async nominatimReverse(
    lat: number,
    lng: number,
  ): Promise<{ lat: number; lng: number; name: string | null }> {
    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: String(lat),
      lon: String(lng),
      'accept-language': 'ar',
    });
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, {
      headers: { 'User-Agent': 'ShuttlezAdmin/1.0 (admin.shuttlez.org)' },
    });
    if (!res.ok) return { lat, lng, name: null };
    const data = (await res.json()) as {
      name?: string;
      display_name?: string;
    };
    return {
      lat,
      lng,
      name: data.name || data.display_name || null,
    };
  }

  /// تحويل معرف OpenStreetMap إلى إحداثيات (يدعم أيضاً صيغة "lat,lng").
  private async nominatimDetails(
    raw: string,
  ): Promise<{ lat: number; lng: number; name: string | null } | null> {
    const direct = parseLatLngId(raw);
    if (direct) return direct;
    if (!/^\d+$/.test(raw)) return null;
    try {
      const params = new URLSearchParams({
        place_id: raw,
        format: 'json',
        'accept-language': 'ar',
      });
      const res = await fetch(`https://nominatim.openstreetmap.org/details?${params}`, {
        headers: { 'User-Agent': 'ShuttlezAdmin/1.0 (admin.shuttlez.org)' },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        localname?: string;
        names?: Record<string, string>;
        centroid?: { coordinates?: [number, number] };
      };
      const coords = data.centroid?.coordinates;
      if (!coords || coords.length < 2) return null;
      const [lng, lat] = coords;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return {
        lat,
        lng,
        name: data.names?.['name:ar'] || data.localname || data.names?.name || null,
      };
    } catch {
      return null;
    }
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
    if (this.hasGoogleKey()) {
      try {
        const google = await this.googleDrivingRoute(input);
        if (google.points.length >= 2) return google;
      } catch {
        // Fall through to OSRM.
      }
    }
    return this.osrmDrivingRoute(input);
  }

  /// مسار قيادة مجاني من OSRM عند غياب مفتاح Google أو فشله.
  private async osrmDrivingRoute(input: {
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
    const coords = [
      { lat: input.originLat, lng: input.originLng },
      ...(input.waypoints ?? []).filter(
        (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng),
      ),
      { lat: input.destLat, lng: input.destLng },
    ]
      .map((p) => `${p.lng},${p.lat}`)
      .join(';');
    const res = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=polyline`,
      { headers: { 'User-Agent': 'ShuttlezApi/1.0 (shuttlez.org)' } },
    );
    if (!res.ok) {
      throw new ServiceUnavailableException(`Routing failed (${res.status})`);
    }
    const data = (await res.json()) as {
      code?: string;
      routes?: Array<{ geometry?: string; duration?: number; distance?: number }>;
    };
    const route = data.routes?.[0];
    if (data.code !== 'Ok' || !route) {
      return { points: [], durationSeconds: 0, distanceMeters: 0 };
    }
    return {
      points: decodePolyline(route.geometry ?? ''),
      durationSeconds: Math.round(route.duration ?? 0),
      distanceMeters: Math.round(route.distance ?? 0),
    };
  }

  private async googleDrivingRoute(input: {
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

function parseLatLngId(
  raw: string,
): { lat: number; lng: number; name: string | null } | null {
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 2) return null;
  const [lat, lng] = parts;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, name: null };
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
