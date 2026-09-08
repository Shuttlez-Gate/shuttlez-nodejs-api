import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

interface LocationPayload {
  regionsByCity?: Record<string, string[]>;
  areasByRegion?: Record<string, string[]>;
}

export class EgyptRouteLocations {
  private static arabic: ReturnType<typeof EgyptRouteLocations.loadMerged> | null =
    null;
  private static english: ReturnType<typeof EgyptRouteLocations.loadMerged> | null =
    null;

  static isEnglish(language?: string | null): boolean {
    return language?.toLowerCase().startsWith('en') === true;
  }

  static cities(language?: string | null): string[] {
    return this.data(language).cities;
  }

  static regionsByCity(language?: string | null): Record<string, string[]> {
    return this.data(language).regionsByCity;
  }

  static areasByRegion(language?: string | null): Record<string, string[]> {
    return this.data(language).areasByRegion;
  }

  private static data(language?: string | null) {
    if (this.isEnglish(language)) {
      this.english ??= this.loadMerged(
        'egypt-location-catalog.en.json',
        'egypt-locations.en.json',
      );
      return this.english;
    }
    this.arabic ??= this.loadMerged(
      'egypt-location-catalog.json',
      'egypt-locations.json',
    );
    return this.arabic;
  }

  private static loadMerged(catalogFile: string, legacyFile: string) {
    const catalog = tryLoad(catalogFile);
    const legacy = tryLoad(legacyFile);
    const regionsByCity: Record<string, string[]> = {};
    const areasByRegion: Record<string, string[]> = {};
    merge(regionsByCity, legacy?.regionsByCity);
    merge(regionsByCity, catalog?.regionsByCity);
    merge(areasByRegion, catalog?.areasByRegion);
    merge(areasByRegion, legacy?.areasByRegion);
    const cities = Object.keys(regionsByCity).sort((a, b) => a.localeCompare(b));
    for (const key of Object.keys(regionsByCity)) {
      regionsByCity[key] = [...new Set(regionsByCity[key])].sort((a, b) =>
        a.localeCompare(b),
      );
    }
    for (const key of Object.keys(areasByRegion)) {
      areasByRegion[key] = [...new Set(areasByRegion[key])].sort((a, b) =>
        a.localeCompare(b),
      );
    }
    return { cities, regionsByCity, areasByRegion };
  }
}

function tryLoad(fileName: string): LocationPayload | null {
  const candidates = [
    join(process.cwd(), 'landing-data', fileName),
    join(__dirname, '../../../landing-data', fileName),
    join(__dirname, '../../../../landing-data', fileName),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf8')) as LocationPayload;
    }
  }
  return null;
}

function merge(
  target: Record<string, string[]>,
  source?: Record<string, string[]>,
): void {
  if (!source) return;
  for (const [key, values] of Object.entries(source)) {
    target[key] = [...(target[key] ?? []), ...values];
  }
}
