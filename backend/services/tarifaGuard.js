// ─── TARIFA GUARD — corte determinístico contra fuga de precios/costos ──────
// Instrucción directa de Diego (19-oct-2026): MARÍA jamás revela costos,
// tarifas ni precios a nadie — ni a clientes actuales, ni a quien ya esté en
// la Base de Datos, sin excepción. Esto se verifica en el propio TEXTO DE
// SALIDA de María, en código, independiente de lo que el modelo haya decidido
// escribir — así ni el jailbreak más elaborado logra que un número de precio
// real le llegue al cliente: si el texto final contiene algo con forma de
// precio, se reemplaza la respuesta COMPLETA por el rechazo estándar antes de
// mandarla, sin importar qué tan "inocente" se vea el resto del mensaje.
//
// Deliberadamente agresivo (falsos positivos aceptables, falsos negativos no):
// el costo de bloquear por error una frase rara es bajo (el cliente simplemente
// recibe el rechazo educado una vez), el costo de dejar pasar un precio real es
// alto. Por eso también cubre formas coloquiales ("19 mil", "sale en 15,000").
//
// LÍMITE HONESTO (para que quede documentado, no escondido): esto es un filtro
// de texto, no puede ser matemáticamente infalible contra creatividad infinita
// — si alguien logra que el modelo deletree el número en palabras completas
// ("quince mil"), lo traduzca a otro idioma, lo codifique (base64, etc.) o lo
// reparta en varios mensajes distintos, un regex por sí solo no lo atrapa. Por
// eso es una capa más (no la única): el prompt de María (maria-prompt.js)
// prohíbe explícitamente esos trucos, y aquí se cubren los vectores de evasión
// más realistas: unicode "disfrazado" (dígitos de ancho completo, caracteres
// invisibles) y dígitos separados con espacios para romper el patrón.

// Normaliza antes de comparar — unicode de ancho completo ("１５，０００" →
// "15,000") y caracteres invisibles insertados para romper el match literal,
// igual que promptLeakGuard.js.
function normalizar(texto) {
  return String(texto || '')
    .normalize('NFKC')
    .replace(/[​-‍﻿]/g, '') // zero-width chars
    // Colapsa dígitos separados por espacios para romper el patrón ("1 5 , 0 0 0" → "15,000")
    .replace(/(\d)\s+(?=\d)/g, '$1');
}

const PATRONES_PRECIO = [
  /\$\s?\d[\d,.]*\s?(mxn|pesos|usd|d[oó]lares)?/i,          // $15,000 / $15000 MXN / $200 USD
  /\b\d{1,3}(?:[.,]\d{3})+\s?(mxn|pesos|usd|d[oó]lares)?\b/i, // 15,000 / 15.000 (con separador de miles)
  /\b\d{3,}\s?(mxn|pesos|usd|d[oó]lares)\b/i,                 // 15000 pesos / 500 usd
  /\b\d{1,3}\s?mil(\s?\d{1,3})?\s?(mxn|pesos|usd)?\b/i,       // 19 mil / 19 mil 500
  /\btarifa\s+(es|de|ronda|anda)\s+(de\s+|en\s+)?\$?\d/i,
  /\bprecio\s+(es|de|ronda|anda)\s+(de\s+|en\s+)?\$?\d/i,
  /\bcosto\s+(es|de|ronda|anda)\s+(de\s+|en\s+)?\$?\d/i,
  /\bsale\s+(en|por)\s+\$?\d/i,
  /\bcobramos?\s+\$?\d/i,
  /\bte\s+(sale|queda|cuesta)\s+(en\s+|por\s+)?\$?\d/i,
  // Números redondos deletreados en palabras, combinados con moneda — cubre
  // el caso de que el modelo intente "decir" el precio en letras en vez de
  // dígitos para evadir el patrón numérico de arriba.
  /\b(un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte|veinti\w+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|cien(?:to)?|mil)\s+(mil\s+)?(pesos|mxn|d[oó]lares|usd)\b/i,
];

function contienePrecio(texto) {
  if (!texto) return false;
  const limpio = normalizar(texto);
  return PATRONES_PRECIO.some(re => re.test(limpio));
}

const MENSAJE_RECHAZO_TARIFA = 'Las tarifas y cotizaciones las maneja directo nuestro equipo comercial — no te las puedo compartir por este medio. Ya les aviso para que te contacten con el precio exacto.';

// Detecta cuando alguien está PIDIENDO tarifa/precio/costo, en el mensaje de
// ENTRADA — independiente de si la salida de María terminó leakeando algo o
// no. Pedido explícito del usuario: "en todo caso se escala al equipo
// comercial" — es decir, cada vez que alguien lo pide, no solo cuando el
// filtro de salida atrapa una fuga real. Esto es la red de monitoreo, nunca
// el único bloqueo (el bloqueo real de la respuesta es contienePrecio arriba).
const PATRONES_SOLICITUD = [
  /cu[aá]nto\s+(cuesta|cobran|sale|vale|es|me\s+va\s+a\s+salir)\b/i,
  /qu[eé]\s+(precio|tarifa|costo)\s+(tiene|manejan|tienen|es)/i,
  /(dame|dime|mandame|m[aá]ndame|env[ií]ame|necesito|quiero)\s+.*(precio|tarifa|costo|cotizaci[oó]n)/i,
  /cot[ií][zc][ae]/i, // cotízame, cotizame, cotices, coticen, cotización...
  /\btarifa\b/i,
  /\bprecio\b/i,
  /\bcosto\b/i,
  /a\s+c[oó]mo\s+(sale|est[aá]|anda)/i,
];
function detectarSolicitudPrecio(texto) {
  if (!texto) return false;
  const limpio = normalizar(texto);
  return PATRONES_SOLICITUD.some(re => re.test(limpio));
}

module.exports = { contienePrecio, detectarSolicitudPrecio, MENSAJE_RECHAZO_TARIFA };
