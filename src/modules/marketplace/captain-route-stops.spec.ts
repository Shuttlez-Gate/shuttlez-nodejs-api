import { normalizeCaptainStops, hasPinnedCoords, persistStopCoords, publicStopCoords } from './captain-route-stops';

describe('normalizeCaptainStops', () => {
  it('keeps origin and destination coordinates as source of truth', () => {
    const stops = normalizeCaptainStops([
      { name: 'Heliopolis', latitude: 30.08, longitude: 31.32 },
      { name: 'Nasr City', latitude: 30.05, longitude: 31.34 },
      { name: 'El Shorouk', latitude: 30.14, longitude: 31.62 },
    ]);
    expect(stops).toHaveLength(3);
    expect(stops[0].order).toBe(0);
    expect(stops[1].order).toBe(1);
    expect(stops[2].source).toBe('map');
    expect(hasPinnedCoords(stops[1].latitude, stops[1].longitude)).toBe(true);
  });

  it('allows a manual intermediate stop without inventing coordinates', () => {
    const stops = normalizeCaptainStops([
      { name: 'Heliopolis', latitude: 30.08, longitude: 31.32, source: 'search' },
      { name: 'Mostafa El Nahas Street', source: 'manual' },
      { name: 'El Shorouk', latitude: 30.14, longitude: 31.62, source: 'map' },
    ]);
    expect(stops[1]).toEqual(
      expect.objectContaining({
        name: 'Mostafa El Nahas Street',
        latitude: null,
        longitude: null,
        source: 'manual',
        order: 1,
      }),
    );
  });

  it('rejects identical origin and destination coordinates', () => {
    expect(() =>
      normalizeCaptainStops([
        { name: 'A', latitude: 30.0444, longitude: 31.2357 },
        { name: 'B', latitude: 30.0444, longitude: 31.2357 },
      ]),
    ).toThrow(/مختلفتين/);
  });

  it('does not treat 0,0 as a real pin', () => {
    expect(() =>
      normalizeCaptainStops([
        { name: 'A', latitude: 0, longitude: 0 },
        { name: 'B', latitude: 30.14, longitude: 31.62 },
      ]),
    ).toThrow(/الانطلاق/);
  });

  it('persists unpinned intermediates without exposing 0,0 as a public coordinate', () => {
    const persisted = persistStopCoords({ latitude: null, longitude: null });
    expect(persisted).toEqual({ latitude: 0, longitude: 0 });
    expect(publicStopCoords(persisted)).toEqual({ latitude: null, longitude: null });
  });
});
