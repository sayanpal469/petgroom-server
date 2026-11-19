/** Straight-line distance in metres between two points (haversine). */
export function distanceM(a, b) {
  const R = 6371_000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const shopOf = (settings) => (Number.isFinite(settings.shopLat) && Number.isFinite(settings.shopLng) ? { lat: settings.shopLat, lng: settings.shopLng } : null);

export const mapsLink = (p) => `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;

/** Price of one pick & drop trip (pickup or drop). Distance is straight-line from the shop, rounded up to 0.1 km. */
export function tripPrice(settings, point) {
  const shop = shopOf(settings);
  if (!shop) return null;
  const km = Math.ceil(distanceM(shop, point) / 100) / 10;
  const extraKm = Math.max(0, Math.ceil(km - settings.pickDropFreeKm));
  return { km, charge: Math.round(settings.pickDropBase + extraKm * settings.pickDropPerKm), inRange: km <= settings.pickDropMaxKm };
}
