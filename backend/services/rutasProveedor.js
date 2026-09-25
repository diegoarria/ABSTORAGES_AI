// Filtro de proveedores por ruta — decide a quién contacta SOFIA cuando entra
// una orden. Reglas fijas (no IA): auditable, y un error nunca es "un mensaje
// a quien no correspondía" sin que se pueda ver por qué.
//
// Formato del campo "rutas" de un proveedor (texto libre, separado por comas,
// punto y coma o saltos de línea):
//   "MTY-GDL"          ruta ida y vuelta entre esas dos plazas
//   "Bajío"            cualquier ruta que toque esa zona
//   "Monterrey"        cualquier ruta que toque esa ciudad
//   "Desde Toluca"    solo cargas que SALEN de esa ciudad
//   "todas" / "nacional"  cualquier ruta
// Un proveedor SIN rutas capturadas nunca se contacta automáticamente.

const GRUPOS = [
  ['monterrey', 'mty', 'nuevo leon', 'nl', 'apodaca', 'guadalupe', 'san nicolas', 'san pedro garza garcia', 'santa catarina', 'escobedo', 'garcia', 'juarez nl', 'salinas victoria', 'ciénega de flores', 'cienega de flores'],
  ['guadalajara', 'gdl', 'jalisco', 'zapopan', 'tlaquepaque', 'tonala', 'el salto', 'tlajomulco'],
  ['cdmx', 'ciudad de mexico', 'df', 'distrito federal', 'mexico df'],
  ['estado de mexico', 'edomex', 'toluca', 'naucalpan', 'tlalnepantla', 'ecatepec', 'cuautitlan', 'cuautitlan izcalli', 'tultitlan'],
  ['queretaro', 'qro'],
  ['leon', 'guanajuato', 'gto', 'irapuato', 'celaya', 'silao', 'salamanca'],
  ['aguascalientes', 'ags'],
  ['san luis potosi', 'slp'],
  ['saltillo', 'coahuila', 'ramos arizpe'],
  ['torreon', 'gomez palacio', 'lerdo'],
  ['puebla', 'pue'],
  ['veracruz', 'ver'],
  ['tijuana', 'tj', 'baja california', 'bc', 'mexicali', 'ensenada'],
  ['chihuahua', 'chih', 'juarez', 'ciudad juarez', 'cd juarez'],
  ['nuevo laredo', 'laredo', 'tamaulipas', 'reynosa', 'matamoros'],
  ['culiacan', 'sinaloa', 'mazatlan', 'los mochis', 'navolato'],
  ['hermosillo', 'sonora', 'nogales', 'obregon'],
  ['merida', 'yucatan'],
  ['manzanillo', 'colima'],
  ['morelia', 'michoacan', 'lazaro cardenas'],
];

// Zonas: nombre → grupos (por su primer alias) que abarca
const ZONAS = {
  bajio: ['queretaro', 'leon', 'aguascalientes', 'san luis potosi'],
  norte: ['monterrey', 'saltillo', 'torreon', 'nuevo laredo', 'chihuahua', 'tijuana', 'hermosillo', 'culiacan'],
  centro: ['cdmx', 'estado de mexico', 'queretaro', 'puebla'],
  occidente: ['guadalajara', 'colima', 'morelia'],
  sureste: ['veracruz', 'merida', 'puebla'],
};

const COMODINES = new Set(['todas', 'todo', 'nacional', 'cualquiera', 'toda la republica', 'republica']);

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Nombres canónicos (primer alias del grupo) a los que corresponde un lugar
function claves(lugar) {
  const l = norm(lugar);
  if (!l) return new Set();
  const out = new Set();
  for (const g of GRUPOS) {
    const alias = g.map(norm);
    if (alias.some(a => a === l || (a.length > 3 && (l.includes(a) || a.includes(l) && l.length > 3)))) out.add(alias[0]);
  }
  if (ZONAS[l]) ZONAS[l].forEach(z => out.add(norm(z)));
  if (!out.size) out.add(l); // lugar desconocido: solo coincide consigo mismo
  return out;
}

function hayInterseccion(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

// "MTY-GDL" / "Monterrey → Guadalajara" / "Bajío" → { lados: [..] }
function parsear(texto) {
  return String(texto || '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean).map(entrada => {
    const t = norm(entrada);
    if (COMODINES.has(t)) return { comodin: true, entrada };
    const desde = /^(desde|salidas? de|sale de)\s+/i.test(t) ? entrada.replace(/^(desde|salidas? de|sale de)\s+/i, '').trim() : null;
    if (desde) return { soloOrigen: desde, entrada };
    const lados = entrada.split(/\s*(?:<->|->|→|↔|–|—|-|>)\s*|\s+a\s+/i).map(s => s.trim()).filter(Boolean);
    return { lados: lados.slice(0, 2), entrada };
  });
}

// ¿Esta lista de rutas cubre origen → destino?
function cubreRuta(rutasTexto, origen, destino) {
  const o = claves(origen), d = claves(destino);
  for (const r of parsear(rutasTexto)) {
    if (r.comodin) return { ok: true, por: r.entrada };
    if (r.soloOrigen) {
      if (hayInterseccion(claves(r.soloOrigen), o)) return { ok: true, por: r.entrada };
    } else if (r.lados.length === 2) {
      const a = claves(r.lados[0]), b = claves(r.lados[1]);
      if ((hayInterseccion(a, o) && hayInterseccion(b, d)) || (hayInterseccion(a, d) && hayInterseccion(b, o))) return { ok: true, por: r.entrada };
    } else if (r.lados.length === 1) {
      const a = claves(r.lados[0]);
      if (hayInterseccion(a, o) || hayInterseccion(a, d)) return { ok: true, por: r.entrada };
    }
  }
  return { ok: false };
}

// Separa los proveedores en contactables (ruta cubierta) y omitidos, con motivo
function filtrarPorRuta(proveedores, origen, destino, tipoUnidad) {
  const elegidos = [], omitidos = [];
  for (const p of proveedores) {
    if (!String(p.rutas || '').trim()) { omitidos.push({ p, motivo: 'sin rutas capturadas' }); continue; }
    const r = cubreRuta(p.rutas, origen, destino);
    if (!r.ok) { omitidos.push({ p, motivo: 'no maneja esa ruta' }); continue; }
    if (!cubreUnidad(p.unidades, tipoUnidad)) { omitidos.push({ p, motivo: 'no maneja ese tipo de unidad' }); continue; }
    elegidos.push(p);
  }
  return { elegidos, omitidos };
}

// ── Tipo de unidad ──────────────────────────────────────────────────────────
const FAMILIAS_UNIDAD = {
  seca: /seca|caja cerrada|dry/, refrigerada: /refriger|termo|reefer|frio/, plataforma: /plataforma|plana|flat/,
  pipa: /pipa|cisterna|tanque/, tolva: /tolva|granel/, torton: /torton|rabon|3\.?5|camioneta|pickup/, cama_baja: /cama baja|low ?boy|lowboy/,
  full: /full|doble remolque|doble articulado/,
};
function familias(texto) {
  const t = norm(texto);
  return new Set(Object.entries(FAMILIAS_UNIDAD).filter(([, re]) => re.test(t)).map(([k]) => k));
}
// Proveedor con unidades capturadas: debe manejar la que pide la orden. Sin
// unidades capturadas, o una orden cuyo tipo no reconocemos, no se descarta
// (la ruta ya es el filtro estricto).
function cubreUnidad(unidadesTexto, tipoOrden) {
  if (!String(unidadesTexto || '').trim()) return true;
  const pedidas = familias(tipoOrden);
  if (!pedidas.size) return true;
  return hayInterseccion(familias(unidadesTexto), pedidas);
}

module.exports = { cubreRuta, cubreUnidad, filtrarPorRuta, parsear };
