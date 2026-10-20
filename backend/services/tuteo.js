// Red de seguridad: si un mensaje saliente trae voseo (vos, tenés, querés…) se
// pasa a tuteo mexicano (tú, tienes, quieres…). Solo formas que en español de
// México no existen o son inequívocas — nada que pueda cambiar el sentido.
//
// Ampliado (20-oct-2026) — pedido explícito del usuario tras confirmar que
// el diccionario original (13 formas) dejaba pasar voseo real en WhatsApp:
// María, SOFIA y NOA ya tienen esta regla en su prompt, pero el prompt no es
// un bloqueo real — el modelo lo puede fallar en seguir. Este diccionario es
// el bloqueo real, en código, sobre el texto de salida.
//
// LÍMITE HONESTO: es un diccionario curado de las conjugaciones de voseo más
// comunes en una conversación de ventas/logística, no un analizador
// morfológico completo de español — cubre lo realista, no cada verbo que
// existe. Si aparece una forma que no está aquí, no se corrige sola; si el
// patrón se repite, vale la pena agregarla.
const FORMAS = {
  // Pronombre y "ser"
  vos: 'tú', sos: 'eres', che: '',
  // Verbos irregulares más comunes
  tenés: 'tienes', querés: 'quieres', podés: 'puedes', sabés: 'sabes',
  necesitás: 'necesitas', decís: 'dices', hacés: 'haces', venís: 'vienes',
  ponés: 'pones', salís: 'sales',
  // Imperativos (muy comunes en instrucciones/pedidos)
  contame: 'cuéntame', decime: 'dime', mirá: 'mira', fijate: 'fíjate',
  escribime: 'escríbeme', pasame: 'pásame', escuchame: 'escúchame',
  esperame: 'espérame', avisame: 'avísame', mandame: 'mándame',
  llamame: 'llámame', confirmame: 'confírmame', andá: 've', pará: 'espera',
  cotizame: 'cotízame',
  // Verbos regulares -ar (voseo nunca diptonga: hablás, no "hablas" con tilde)
  hablás: 'hablas', mandás: 'mandas', llamás: 'llamas', enviás: 'envías',
  confirmás: 'confirmas', revisás: 'revisas', checás: 'checas',
  platicás: 'platicas', esperás: 'esperas', pensás: 'piensas',
  trabajás: 'trabajas', manejás: 'manejas', cargás: 'cargas',
  entregás: 'entregas', pagás: 'pagas', cobrás: 'cobras', ayudás: 'ayudas',
  mencionás: 'mencionas', dejás: 'dejas', cotizás: 'cotizas', armás: 'armas',
  tomás: 'tomas', llegás: 'llegas',
  // Verbos regulares -er/-ir
  entendés: 'entiendes', creés: 'crees', volvés: 'vuelves', seguís: 'sigues',
  pedís: 'pides', escribís: 'escribes', recibís: 'recibes', subís: 'subes',
  perdés: 'pierdes',
  // Subjuntivo de voseo (frases con "cuando"/"si")
  llegués: 'llegues', tengás: 'tengas', vengás: 'vengas', mandés: 'mandes',
  confirmés: 'confirmes', avisés: 'avises',
};
// Los límites de palabra van con \p{L} (el \b de JS no reconoce las vocales con acento)
const PARES = Object.entries(FORMAS).map(([f, nuevo]) => [new RegExp('(?<![\\p{L}])' + f + '(?![\\p{L}])', 'giu'), nuevo]);
function conservarMayuscula(orig, nuevo) { return orig[0] === orig[0].toUpperCase() && orig[0] !== orig[0].toLowerCase() ? nuevo.charAt(0).toUpperCase() + nuevo.slice(1) : nuevo; }
function aTuteo(texto) {
  if (!texto) return texto;
  let t = String(texto);
  for (const [re, nuevo] of PARES) t = t.replace(re, m => conservarMayuscula(m, nuevo));
  return t.replace(/ {2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/,\s*([.!?])/g, '$1').replace(/^[,\s]+/, '');
}
module.exports = { aTuteo };
