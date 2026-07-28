// Reverse geocoding compartido por todos los proveedores de GPS — convierte
// lat/lng en una dirección legible (Nominatim/OpenStreetMap, gratuito).
async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16`, {
      headers: { 'User-Agent': 'ABSTORAGES-ops/1.0 (contacto@abstorages.com)' },
    });
    const data = await r.json();
    return data.display_name || null;
  } catch {
    return null;
  }
}

module.exports = { reverseGeocode };
