export function normalizeLocation(value?: string | null): string {
  if (!value) return '';
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function buildRouteKey(fromNormalized: string, toNormalized: string): string {
  if (!fromNormalized || !toNormalized) return '';
  return [fromNormalized, toNormalized].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join('|');
}

export function buildDisplayLabel(fromLabel: string, toLabel: string): string {
  return `${fromLabel.trim()} ↔ ${toLabel.trim()}`;
}

export function deriveRouteKeys(routeName: string): string[] {
  if (!routeName?.trim()) return [];
  const parts = splitRouteName(routeName);
  if (parts.length !== 2) return [];
  const key = buildRouteKey(normalizeLocation(parts[0]), normalizeLocation(parts[1]));
  return key ? [key] : [];
}

function splitRouteName(name: string): string[] {
  const separators = ['↔', '⟷', ' - ', ' – ', ' — ', '-', '–', '—'];
  for (const sep of separators) {
    const idx = name.indexOf(sep);
    if (idx <= 0) continue;
    const left = name.slice(0, idx).trim();
    const right = name.slice(idx + sep.length).trim();
    if (left && right) return [left, right];
  }
  return [];
}
