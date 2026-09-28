// Red de seguridad: si un mensaje saliente trae voseo (vos, tenés, querés…) se
// pasa a tuteo mexicano (tú, tienes, quieres…). Solo formas que en español de
// México no existen o son inequívocas — nada que pueda cambiar el sentido.
const FORMAS = {
  vos: 'tú', sos: 'eres', tenés: 'tienes', querés: 'quieres', podés: 'puedes', sabés: 'sabes', necesitás: 'necesitas', decís: 'dices',
  hacés: 'haces', venís: 'vienes', pensás: 'piensas', mandás: 'mandas', llamás: 'llamas', contame: 'cuéntame', decime: 'dime',
  mirá: 'mira', fijate: 'fíjate', escribime: 'escríbeme', pasame: 'pásame', che: '',
};
// Los límites de palabra van con \p{L} (el \b de JS no reconoce las vocales con acento)
const PARES = Object.entries(FORMAS).map(([f, nuevo]) => [new RegExp('(?<![\\p{L}])' + f + '(?![\\p{L}])', 'giu'), nuevo]);
function conservarMayuscula(orig, nuevo) { return orig[0] === orig[0].toUpperCase() && orig[0] !== orig[0].toLowerCase() ? nuevo.charAt(0).toUpperCase() + nuevo.slice(1) : nuevo; }
function aTuteo(texto) {
  if (!texto) return texto;
  let t = String(texto);
  for (const [re, nuevo] of PARES) t = t.replace(re, m => conservarMayuscula(m, nuevo));
  return t.replace(/ {2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/,\s*([.!?])/g, '$1');
}
module.exports = { aTuteo };
