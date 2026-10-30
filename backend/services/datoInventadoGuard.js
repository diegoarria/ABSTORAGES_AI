// ─── DATO INVENTADO GUARD — corte determinístico contra cifras inventadas ───
// Nace de un incidente verificado el 30-oct-2026: simulando una difusión por
// ruta SIN dar toneladas, SOFIA respondió igual "tengo 24 toneladas" — un
// número que nunca estuvo en ningún lado, tomado de un ejemplo que había en
// el texto de instrucción interno (ver sofiaOperacion.js). Se corrigió ese
// caso puntual a mano, pero el patrón (inventar una cifra operativa cuando no
// la tiene) puede repetirse en cualquier otro lugar del prompt.
//
// Mismo criterio que tarifaGuard.js: el bloqueo real no depende de que el
// prompt obedezca — se verifica el TEXTO DE SALIDA contra lo que de verdad
// está en el contexto de ESTA conversación (el system prompt completo que se
// le mandó al modelo), en código. Si SOFIA menciona una cifra de toneladas
// que no aparece respaldada en su propio contexto, se asume inventada y se
// reemplaza TODA la respuesta — deliberadamente agresivo: el costo de un
// falso positivo (bloquear una mención rara que sí era real pero el regex no
// la vio) es bajo, el costo de dejar pasar un dato operativo inventado a un
// proveedor es alto.
//
// LÍMITE HONESTO: solo cubre toneladas/peso por ahora (la categoría que ya
// se demostró que falla) — no es un verificador genérico de cualquier cifra.

function normalizar(texto) {
  return String(texto || '').normalize('NFKC').replace(/[​-‏﻿]/g, '');
}

// "24 toneladas" / "24.5 ton" / "24,5 toneladas" — unidad de peso, no folios
// ni teléfonos ni horas.
const PATRON_TONELADAS = /(\d+(?:[.,]\d+)?)\s*(?:ton(?:eladas?)?\b)/gi;

function extraerToneladas(texto) {
  const out = new Set();
  for (const m of normalizar(texto).matchAll(PATRON_TONELADAS)) {
    out.add(parseFloat(m[1].replace(',', '.')));
  }
  return out;
}

// ¿La respuesta menciona una cifra de toneladas que NO está respaldada por
// el contexto completo de esta conversación (el system prompt)?
function tieneToneladasInventadas(respuesta, contextoCompleto) {
  const dichas = extraerToneladas(respuesta);
  if (!dichas.size) return false;
  const conocidas = extraerToneladas(contextoCompleto);
  for (const n of dichas) if (!conocidas.has(n)) return true;
  return false;
}

const MENSAJE_DATO_SIN_CONFIRMAR = 'Ahorita no tengo esa cifra confirmada — lo checo con el equipo y te confirmo.';

module.exports = { tieneToneladasInventadas, extraerToneladas, MENSAJE_DATO_SIN_CONFIRMAR };
