/* ── Place name → coordinates ──
   Default: Photon (komoot), built on OpenStreetMap, free and keyless, meant
   for search-as-you-type traffic. Nominatim is available for one-off lookups,
   but its usage policy forbids heavy use and requires an identifying
   User-Agent, so don't put it behind a public search box. */

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

/** @returns {Promise<{name: string, lat: number, lon: number, kind?: string, extentM?: number}[]>} */
export async function geocode(query, { limit = 5, provider = 'photon', userAgent } = {}) {
  if (provider === 'nominatim') {
    const r = await fetch(`${NOMINATIM}?format=json&limit=${limit}&q=${encodeURIComponent(query)}`,
      userAgent ? { headers: { 'User-Agent': userAgent } } : undefined);
    if (!r.ok) throw new Error(`geocode HTTP ${r.status}`);
    return (await r.json()).map((p) => ({
      name: p.display_name, lat: +p.lat, lon: +p.lon, kind: p.type,
      extentM: p.boundingbox ? extentMetres(+p.boundingbox[0], +p.boundingbox[1], +p.boundingbox[2], +p.boundingbox[3]) : undefined,
    }));
  }
  const r = await fetch(`${PHOTON}?limit=${limit}&q=${encodeURIComponent(query)}`);
  if (!r.ok) throw new Error(`geocode HTTP ${r.status}`);
  return (await r.json()).features.map((f) => {
    const p = f.properties, [lon, lat] = f.geometry.coordinates, e = p.extent; // [minLon, maxLat, maxLon, minLat]
    return {
      name: [p.name, p.city !== p.name ? p.city : null, p.state, p.country].filter(Boolean).join(', '),
      lat, lon, kind: p.osm_value,
      extentM: e ? extentMetres(e[3], e[1], e[0], e[2]) : undefined,
    };
  });
}

/** The larger side of a lat/lon box, in metres. */
function extentMetres(south, north, west, east) {
  const midLat = ((south + north) / 2) * (Math.PI / 180);
  return Math.max((north - south) * 111320, (east - west) * 111320 * Math.cos(midLat));
}
