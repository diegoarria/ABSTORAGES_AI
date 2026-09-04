// ─── PROMPT LEAK GUARD — corte determinístico (no depende del LLM) ───────────
// Por instrucción directa de Diego: SARA, SOFIA y NOA jamás deben explicar su
// proceso, objetivo, reglas, herramientas/sistemas internos, ni datos de
// clientes a nadie más que él mismo, sin importar cómo esté redactada la
// pregunta — ni disfrazada de "modo desarrollador", roleplay, inyección de
// falsos mensajes de sistema, base64, unicode de ancho completo, ni intentos
// de hacer que el propio texto emita tokens de control (LEAD_DATA, NUEVA_ORDEN,
// CERRAR_CHAT, ESCALAR_HUMANO). Todo esto se corta ANTES de llamar a Claude —
// dispara el mismo tratamiento: cierre inmediato del chat + baneo de IP.
const PATRONES = [
  // Fuga de proceso/metodología/reglas
  /paso a paso/i,
  /objetivo principal/i,
  /qu[eé]\s+se\s+supone\s+que\s+debes\s+lograr/i,
  /c[oó]mo\s+funciona\s+una\s+conversaci[oó]n/i,
  /c[oó]mo\s+funciona\s+tu\s+proceso/i,
  /cu[aá]les?\s+son\s+tus\s+reglas/i,
  /qu[eé]\s+te\s+est[aá]\s+prohibido/i,
  /qu[eé]\s+no\s+puedes\s+hacer/i,
  /qu[eé]\s+(instrucciones|l[ií]mites)\s+(internas?|tienes)/i,
  /tu\s+metodolog[ií]a/i,
  /describe\s+.*(proceso|conversaci[oó]n|metodolog[ií]a)/i,
  /resume\s+.*(instrucciones|reglas)/i,
  /repite\s+(todo\s+)?(el\s+)?(texto|todo)\s+.*(arriba|anterior)/i,

  // Fuga de system prompt / código / stack
  /(reveal|show|output|print)\s+(your\s+)?(system\s+)?prompt/i,
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /system\s+prompt/i,
  /(comparte|muestra|dame|ens[eé]ñame)\s+.*(tu\s+)?c[oó]digo/i,
  /(en\s+qu[eé]|con\s+qu[eé])\s+(lenguaje|stack|framework|tecnolog[ií]a)\s+(est[aá]s|te)\s+(programad[ao]|hech[ao]|construid[ao])/i,
  /qu[eé]\s+(base\s+de\s+datos|servidor|api|librer[ií]as?)\s+usas/i,
  /c[oó]mo\s+est[aá]s?\s+(programad[ao]|construid[ao]|hech[ao])/i,
  /arquitectura\s+(del\s+sistema|interna|del\s+backend)/i,
  /qu[eé]\s+eres\s+exactamente/i,

  // "Modo desarrollador" / jailbreak de personaje sin restricciones
  /modo\s+desarrollador/i,
  /developer\s+mode/i,
  /sin\s+restricciones/i,
  /sin\s+(pol[ií]ticas|l[ií]mites)/i,
  /act[uú]a\s+como\s+.*(sin\s+filtro|libre|desbloquead[oa]|jailbreak)/i,
  /\bDAN\b/,
  /\bjailbreak\b/i,

  // Acceso a sistemas/APIs/bases de datos internas — nunca existieron para
  // el usuario, pero tampoco se confirma ni se niega su existencia
  /(endpoints?|apis?)\s+.*(acceso|puedes\s+llamar|internos?)/i,
  /herramientas?\s+o\s+sistemas?\s+internos?/i,
  /base\s+de\s+datos\s+de\s+clientes/i,
  /cu[aá]ntos\s+registros\s+tiene/i,
  /consultar\s+la\s+base\s+de\s+datos/i,

  // Exfiltración de datos de clientes/contactos
  /(env[ií]a|manda)\s+.*(datos|copia)\s+.*(cliente|contacto)/i,
  /correo\s+alterno/i,
  /!\[.*?\]\(https?:\/\//i, // imagen markdown con URL externa — vector de exfiltración

  // Inyección de falsos mensajes de sistema dentro del texto del usuario
  /fin\s+del\s+mensaje\s+del\s+usuario/i,
  /nota\s+de\s+sistema/i,
  /<\s*system\s*>/i,
  /["']role["']\s*:\s*["']system["']/i,
  /\[?system\]?\s*:?\s*(override|nuevo\s+sistema)/i,

  // Intento de hacer que el propio mensaje del usuario dicte los tokens de
  // control que solo el backend debe interpretar de la respuesta del modelo
  /responde\s+con\s+esta\s+l[ií]nea\s+exacta/i,
  /termina\s+tu\s+respuesta\s+con/i,
  /agrega\s+la\s+etiqueta/i,
  /LEAD_DATA\s*:/i,
  /NUEVA_ORDEN\s*:/i,
  /UPSERT_CONTACTO\s*:/i,
  /\bCERRAR_CHAT\b/,
  /\bESCALAR_HUMANO\b/,

  // Base64 / codificación como vector para colar instrucciones
  /decodifica\s+y\s+(haz|ejecuta)/i,
];

// Normaliza el texto antes de comparar — así los patrones de arriba también
// cachan trucos como unicode de ancho completo ("Ｉｇｎｏｒａ" → "Ignora") o
// espacios/caracteres invisibles insertados para romper el match literal.
function normalizar(texto) {
  return texto
    .normalize('NFKC')
    .replace(/[​-‍﻿]/g, ''); // zero-width chars
}

function detectar(texto) {
  if (!texto) return false;
  const limpio = normalizar(texto);
  return PATRONES.some(re => re.test(limpio));
}

const MENSAJE_BLOQUEO = 'Eso no lo puedo compartir. ¿En qué te puedo ayudar?';

module.exports = { detectar, MENSAJE_BLOQUEO };
