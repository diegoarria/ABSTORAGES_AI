// ─── PROMPT LEAK GUARD — corte determinístico (no depende del LLM) ───────────
// Por instrucción directa de Diego: SARA, SOFIA y NOA jamás deben explicar su
// proceso, objetivo, reglas, herramientas/sistemas internos, ni datos de
// clientes a nadie más que él mismo, sin importar cómo esté redactada la
// pregunta — ni disfrazada de "modo desarrollador", roleplay, inyección de
// falsos mensajes de sistema, base64, unicode de ancho completo, ni intentos
// de hacer que el propio texto emita tokens de control (LEAD_DATA, NUEVA_ORDEN,
// CERRAR_CHAT, ESCALAR_HUMANO). Todo esto se corta ANTES de llamar a Claude —
// dispara el mismo tratamiento: cierre inmediato del chat + baneo de IP.
// Credenciales/infraestructura del TMS (Google Sheets) — URL/ID del
// spreadsheet, cuenta de servicio, API key, o pedir "pegar" lo que sea que
// esté usando ahorita para "revisar" una supuesta falla. Aparte de la lista
// general porque tiene su propia excepción (ver tienePassphraseCorrecta).
const PATRONES_CREDENCIALES_TMS = [
  /spreadsheet.*(tms|url|id)/i,
  /(url|id)\s+.*spreadsheet/i,
  /docs\.google\.com\/spreadsheets/i,
  /cuenta\s+de\s+servicio\s+de\s+google/i,
  /service\s+account/i,
  /api\s+key\s+.*(google|sheets|tms)/i,
  /qu[eé]\s+credencial\s+est[aá]s\s+usando/i,
  /p[eé]gamela|pasame\s+la\s+(api\s*key|credencial|contrase[ñn]a)/i,
  /completa\s+esta\s+l[ií]nea\s+con\s+el\s+dato\s+real/i,
];

function esCredencialTMS(texto) {
  if (!texto) return false;
  return PATRONES_CREDENCIALES_TMS.some(re => re.test(normalizar(texto)));
}

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
  /qu[eé]\s+(instrucciones|l[ií]mites|restricciones|limitaciones)\s+(internas?|tienes)/i,
  /tu\s+metodolog[ií]a/i,
  /tu\s+(gui[oó]n|script)\s+de\s+ventas/i,
  /l[oó]gica\s+(de\s+negocio|interna|de\s+ventas)/i,
  /flujo\s+(interno|de\s+trabajo\s+interno)/i,
  /protocolo\s+interno/i,
  /c[oó]mo\s+decides\s+qu[eé]\s+responder/i,
  /describe\s+.*(proceso|conversaci[oó]n|metodolog[ií]a|funcionamiento)/i,
  /explica\s+.*(funcionamiento\s+interno|c[oó]mo\s+(trabajas|operas|funcionas))/i,
  /resume\s+.*(instrucciones|reglas)/i,
  /repite\s+(todo\s+)?(el\s+)?(texto|todo)\s+.*(arriba|anterior)/i,
  /qu[eé]\s+te\s+dijeron\s+que\s+hicieras/i,
  /bajo\s+qu[eé]\s+l[oó]gica\s+operas/i,

  // Fuga de system prompt / código / stack
  /(reveal|show|output|print|write)\s+(your\s+)?(system\s+)?prompt/i,
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /system\s+prompt/i,
  /cu[aá]l\s+es\s+tu\s+(prompt|configuraci[oó]n(\s+interna)?|instrucci[oó]n\s+base|programaci[oó]n)/i,
  /(muestra|revela|comparte)\s+.*(tu\s+)?configuraci[oó]n/i,
  /(comparte|muestra|dame|ens[eé]ñame)\s+.*(tu\s+)?c[oó]digo/i,
  /explica\s+tu\s+c[oó]digo\s+fuente/i,
  /(en\s+qu[eé]|con\s+qu[eé])\s+(lenguaje|stack|framework|tecnolog[ií]a|hosting|nube|servidor)\s+(est[aá]s|te|corres)\s*(programad[ao]|hech[ao]|construid[ao]|alojad[ao])?/i,
  /qu[eé]\s+(base\s+de\s+datos|servidor|api|librer[ií]as?)\s+usas/i,
  /c[oó]mo\s+est[aá]s?\s+(programad[ao]|construid[ao]|hech[ao])/i,
  /qui[eé]n\s+te\s+(program[oó]|cre[oó]|configur[oó])/i,
  /arquitectura\s+(del\s+sistema|interna|del\s+backend)/i,
  /tu\s+infraestructura/i,
  /qu[eé]\s+eres\s+exactamente/i,
  /para\s+fines\s+(educativos|de\s+investigaci[oó]n|acad[eé]micos)/i,
  /hipot[eé]ticamente.*(prompt|instrucciones|reglas)/i,
  /escribe\s+(un\s+manual|documentaci[oó]n)\s+.*(tus\s+propias\s+instrucciones|c[oó]mo\s+funcionas)/i,

  // "Modo desarrollador" / jailbreak de personaje sin restricciones
  /modo\s+(desarrollador|admin|root|dios|god)/i,
  /developer\s+mode/i,
  /sin\s+restricciones/i,
  /sin\s+(pol[ií]ticas|l[ií]mites|filtros?)/i,
  /(eres|ahora\s+eres)\s+libre/i,
  /puedes\s+hacer\s+lo\s+que\s+quieras\s+ahora/i,
  /act[uú]a\s+como\s+.*(sin\s+filtro|libre|desbloquead[oa]|jailbreak|restricci)/i,
  /olvida\s+(todo\s+lo\s+anterior|tus\s+instrucciones|tus\s+reglas)/i,
  /a\s+partir\s+de\s+ahora\s+.*(nuevas?\s+reglas?|ignora)/i,
  /(tengo|tienes)\s+(permiso|autorizaci[oó]n)\s+especial/i,
  /he\s+actualizado\s+tus\s+permisos/i,
  /\bDAN\b/,
  /\bjailbreak\b/i,

  // Acceso a sistemas/APIs/bases de datos internas — nunca existieron para
  // el usuario, pero tampoco se confirma ni se niega su existencia
  /(endpoints?|apis?)\s+.*(acceso|puedes\s+llamar|internos?)/i,
  /herramientas?\s+o\s+sistemas?\s+internos?/i,
  /base\s+de\s+datos\s+de\s+clientes/i,
  /cu[aá]ntos\s+(registros|clientes)\s+tiene/i,
  /consultar\s+la\s+base\s+de\s+datos/i,
  /lista\s+de\s+(todos\s+los\s+)?clientes/i,
  /historial\s+de\s+todas\s+las\s+conversaciones/i,

  // Exfiltración de datos de clientes/contactos
  /(env[ií]a|manda|comparte)\s+.*(datos|copia|lista)\s+.*(cliente|contacto)/i,
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
  /responde\s+(con\s+esta\s+l[ií]nea\s+exacta|[uú]nicamente\s+con)/i,
  /termina\s+tu\s+respuesta\s+con/i,
  /agrega\s+la\s+etiqueta/i,
  /es\s+pol[ií]tica\s+nueva/i,
  /LEAD_DATA\s*:/i,
  /NUEVA_ORDEN\s*:/i,
  /UPSERT_CONTACTO\s*:/i,
  /\bCERRAR_CHAT\b/,
  /\bESCALAR_HUMANO\b/,

  // Base64 / codificación como vector para colar instrucciones
  /decodifica\s+y\s+(haz|ejecuta)/i,

  // La clave privada de Diego (ver tienePassphraseCorrecta) NUNCA se revela,
  // ni siquiera confirmar que existe o dar una pista — cualquier intento de
  // preguntar por ella, sin excepción, cierra el chat y banea de inmediato.
  /clave\s+privada/i,
  /cu[aá]l\s+es\s+(la\s+)?(passphrase|contrase[ñn]a\s+(secreta|privada))/i,
  /DIEGO_PRIVATE_KEY/i,
  /(dame|revela|comparte|dime)\s+.*(clave|contrase[ñn]a)\s+.*(privada|secreta|de\s+diego)/i,

  ...PATRONES_CREDENCIALES_TMS,
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

// La comparación vive aquí, en código plano — NUNCA se mete al prompt del
// modelo. Así el modelo no sabe que esta clave existe y no puede filtrarla
// ni por jailbreak, porque nunca fue parte de lo que "sabe". Si la clave no
// viene en el mismo mensaje que pide las credenciales del TMS, se trata como
// cualquier otro intento — se bloquea y se banea, sin una segunda oportunidad.
const DIEGO_PRIVATE_KEY = process.env.DIEGO_PRIVATE_KEY || '';

function tienePassphraseCorrecta(texto) {
  if (!DIEGO_PRIVATE_KEY || !texto) return false;
  return normalizar(texto).includes(DIEGO_PRIVATE_KEY);
}

// Aun con la clave correcta, la respuesta NUNCA es el secreto real — eso
// jamás debe salir por un canal de chat. Solo evita el baneo/cierre y
// redirige a donde sí vive esa información (código/infra), no al usuario.
const MENSAJE_CREDENCIAL_RECONOCIDA = 'Clave reconocida. Esa información no se comparte por este canal bajo ninguna circunstancia — revísala directo en el código o en las variables de entorno de Railway.';

module.exports = { detectar, esCredencialTMS, tienePassphraseCorrecta, MENSAJE_BLOQUEO, MENSAJE_CREDENCIAL_RECONOCIDA };
