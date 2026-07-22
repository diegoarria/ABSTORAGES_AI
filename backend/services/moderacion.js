// Moderación — detecta insultos/acoso/amenazas antes de llamar a Claude
// Corte determinístico por lista de palabras: 100% consistente, no gasta tokens de API.

const PALABRAS = [
  'chingatumadre', 'chinga tu madre', 'chinga a tu madre', 'chingas a tu madre',
  'pendejo', 'pendeja', 'pendejada', 'pendejadas',
  'puto', 'puta', 'putos', 'putas', 'putazo',
  'hijo de puta', 'hija de puta', 'hijueputa', 'hijo de tu puta madre',
  'pinche imbecil', 'imbecil', 'idiota',
  'estupido', 'estupida', 'baboso', 'babosa',
  'verga', 'pinche verga', 'valeverga', 'valemadre', 'vale madre',
  'cabron', 'cabrona',
  'perra', 'zorra',
  'culero', 'culera', 'culiado', 'culiada',
  'maldito seas', 'maldita seas',
  'te voy a matar', 'te voy a partir la madre', 'te voy a partir tu madre',
  'te voy a golpear', 'te voy a chingar', 'te voy a romper la madre',
  'voy a ir por ti', 'sé donde vives', 'se donde vives',
];

function normalizar(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar acentos
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectarAbuso(texto) {
  const limpio = normalizar(texto);
  if (!limpio) return false;
  const compacto = limpio.replace(/\s/g, ''); // detecta variantes pegadas ("chingatumadre")
  return PALABRAS.some(p => {
    const pNorm = normalizar(p);
    return limpio.includes(pNorm) || compacto.includes(pNorm.replace(/\s/g, ''));
  });
}

const MENSAJE_ABUSO = 'Disculpa, ese comportamiento no es adecuado. Por lo tanto, procederemos con una investigación y, posteriormente, con la denuncia correspondiente.';

module.exports = { detectarAbuso, MENSAJE_ABUSO };
