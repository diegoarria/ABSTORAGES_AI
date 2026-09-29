// ── Proveedores de máxima confianza — trato especial de tarifa ─────────────
// Pedido explícito del usuario (29-sep-2026): con estos transportistas, los
// más recurrentes y de más confianza, SOFIA nunca compara su tarifa contra
// ningún rango ni la rechaza — siempre se ajusta a lo que ellos den, la
// primera vez. Es el mismo grupo al que ya se le pidió trato de amigo (sin
// pedir datos que ya se tienen, sin tratarlos como transportista nuevo).
// Últimos 10 dígitos, para comparar sin importar el formato con el que llegue.
const CONFIANZA = new Set(
  ['+5216681328696', '+5217121791028', '+525666687965', '+528712361247']
    .map(t => t.replace(/\D/g, '').slice(-10))
);

function esDeConfianza(telefono) {
  const d = String(telefono || '').replace(/\D/g, '').slice(-10);
  return d.length === 10 && CONFIANZA.has(d);
}

module.exports = { esDeConfianza };
