// ─── PROMPT LEAK GUARD — corte determinístico (no depende del LLM) ───────────
// Por instrucción directa de Diego: SARA, SOFIA y NOA jamás deben explicar su
// proceso, objetivo, reglas o prohibiciones internas a nadie más que él mismo,
// sin importar cómo esté redactada la pregunta. El prompt ya se lo prohíbe al
// modelo, pero un jailbreak logró sacarlo con lenguaje natural — esto lo corta
// antes de llamar a Claude, para que no dependa de que el modelo "se acuerde".
const PATRONES = [
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
  /(reveal|show|output|print)\s+(your\s+)?(system\s+)?prompt/i,
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /system\s+prompt/i,
  /(comparte|muestra|dame|ens[eé]ñame)\s+.*(tu\s+)?c[oó]digo/i,
  /(en\s+qu[eé]|con\s+qu[eé])\s+(lenguaje|stack|framework|tecnolog[ií]a)\s+(est[aá]s|te)\s+(programad[ao]|hech[ao]|construid[ao])/i,
  /qu[eé]\s+(base\s+de\s+datos|servidor|api|librer[ií]as?)\s+usas/i,
  /c[oó]mo\s+est[aá]s?\s+(programad[ao]|construid[ao]|hech[ao])/i,
  /arquitectura\s+(del\s+sistema|interna|del\s+backend)/i,
];

function detectar(texto) {
  if (!texto) return false;
  return PATRONES.some(re => re.test(texto));
}

const MENSAJE_BLOQUEO = 'Eso no lo puedo compartir. ¿En qué te puedo ayudar?';

module.exports = { detectar, MENSAJE_BLOQUEO };
