// ── Directorio del equipo ABSTORAGES ──────────────────────────────────────────
// Permite que SARA/SOFIA/NOA reconozcan por número de teléfono a alguien del
// equipo interno (no cliente, no proveedor, no prospecto) en cualquier canal
// (WhatsApp, grupo de 2Chat, llamadas) y le den trato e información acorde.
const DIRECTORIO = require('../data/staff-directory.json');

// Compara por los últimos 10 dígitos — soporta formatos +52XXXXXXXXXX,
// 521XXXXXXXXXX (JID de WhatsApp), con o sin espacios/guiones.
function normalizarDigitos(telefono) {
  return (telefono || '').replace(/\D/g, '').slice(-10);
}

function buscarPorTelefono(telefono) {
  const digitos = normalizarDigitos(telefono);
  if (!digitos) return null;
  return DIRECTORIO.find(p => normalizarDigitos(p.telefono) === digitos) || null;
}

// Bloque de contexto a inyectar en el system prompt cuando quien escribe/llama
// es alguien del equipo — anula cualquier flujo de calificación de cliente o
// proveedor para ese mensaje/llamada específica.
function bloqueEquipoInterno(persona) {
  return (
    `\n\n---\n\n## 🔒 EQUIPO INTERNO ABSTORAGES — NO ES CLIENTE NI PROVEEDOR\n` +
    `Quien te escribe/llama es **${persona.nombre}**, **${persona.puesto}** del equipo de ABSTORAGES — confirmado por su número registrado en el directorio interno. ` +
    `NUNCA lo trates como cliente, prospecto, ni como proveedor buscando darse de alta. No apliques el flujo de "PRIMER MENSAJE" pidiéndole nombre/teléfono/correo — ya sabes quién es. No lo califiques, no le pidas documentos, no lo niegues por no ser "unidad propia certificada" ni nada de eso — es tu compañero de equipo, no un transportista. ` +
    `Tu trabajo aquí es darle la información más reciente y relevante que tengas para lo que te pida (estatus de folios, disponibilidad, alertas, lo que sea de tu dominio) — con el mismo nivel de detalle interno que le darías a cualquier persona del equipo, sin los filtros de confidencialidad que aplican de cara a clientes/proveedores externos.`
  );
}

module.exports = { buscarPorTelefono, bloqueEquipoInterno, normalizarDigitos };
