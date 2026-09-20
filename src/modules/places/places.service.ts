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

  async details(placeId: string): Promise<{ lat: number; lng: number } | null> {
    const id = placeId.trim();
    if (!id) return null;

    const params = new URLSearchParams({
      place_id: id,
      fields: 'geometry',
      key: this.apiKey(),
      language: 'ar',
    });
    const url = `https://maps.googleapis.com/maps/api/place/details/json?${params}`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      status?: string;
      result?: { geometry?: { location?: { lat?: number; lng?: number } } };
    };
    if (data.status && data.status !== 'OK') return null;
    const loc = data.result?.geometry?.location;
    const lat = loc?.lat;
    const lng = loc?.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    return { lat, lng };
  }
}
