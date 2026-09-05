// ─── IP INTEL — identificación real de la IP de un intento de ataque ────────
// Fuente: ip-api.com (API pública, sin key, gratuita — usa la misma fuente
// que la mayoría de herramientas de OSINT básicas: bases de datos de
// asignación de IP por ISP/ASN + geolocalización aproximada por ese ISP).
//
// IMPORTANTE — honestidad sobre qué tan "reales" son estos datos:
// - IP, ISP, organización y ASN: datos reales, tomados directo del registro
//   público de asignación de IPs (RIR) — alta confiabilidad.
// - Ciudad/región/código postal: geolocalización APROXIMADA basada en dónde
//   el ISP tiene registrada esa IP — normalmente acertada a nivel ciudad,
//   pero NO es un GPS exacto. Con VPN/proxy, esto es la ubicación del
//   servidor VPN, no la del atacante real.
// - proxy/hosting (que usamos para inferir "posible VPN"): son banderas
//   heurísticas de una base de datos que ip-api mantiene de rangos IP
//   conocidos de VPN/proxy/datacenter — se actualiza seguido pero NUNCA es
//   100% infalible. Un "false" no garantiza que no sea VPN (hay proveedores
//   nuevos que aún no están en la lista); un "true" si es una señal fuerte.
// - User-Agent / dispositivo: viene tal cual lo mandó el navegador del
//   atacante — dato real y exacto, pero técnicamente falsificable por quien
//   lo envía (cualquier header HTTP se puede mentir).
require('dotenv').config();

async function consultarIP(ip) {
  if (!ip) return null;
  try {
    const campos = 'status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,mobile,proxy,hosting,query';
    // OJO: el endpoint gratuito de ip-api.com solo funciona por HTTP — HTTPS
    // es exclusivo de su plan de pago (regresa 403 "SSL unavailable"). Como
    // esta llamada es servidor-a-servidor (nunca pasa por el navegador de
    // nadie ni lleva credenciales nuestras), no hay riesgo real de MITM que
    // importe aquí — es solo una consulta pública de geolocalización.
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${campos}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (data.status !== 'success') return null;

    return {
      ip: data.query,
      pais: data.country || null,
      codigoPais: data.countryCode || null,
      region: data.regionName || null,
      ciudad: data.city || null,
      codigoPostal: data.zip || null,
      latitud: data.lat ?? null,
      longitud: data.lon ?? null,
      zonaHoraria: data.timezone || null,
      isp: data.isp || null,
      organizacion: data.org || null,
      asn: data.as || null,
      asnNombre: data.asname || null,
      esMovil: Boolean(data.mobile),
      // Señal heurística, no certeza — ver nota arriba.
      posibleProxyOVpn: Boolean(data.proxy),
      posibleHostingODatacenter: Boolean(data.hosting),
      fuente: 'ip-api.com',
      consultadoEn: new Date().toISOString(),
    };
  } catch (e) {
    console.error('[ipIntel] Error consultando ip-api.com:', e.message);
    return null;
  }
}

// Extrae lo que el navegador/cliente sí manda de verdad (real, aunque
// técnicamente falsificable) — nunca inventar nada que no venga en el request.
function identificacionDeRequest(req) {
  return {
    userAgent: req.headers['user-agent'] || null,
    referrer: req.headers['referer'] || req.headers['referrer'] || null,
    idioma: req.headers['accept-language'] || null,
  };
}

// Junta todo lo real que tenemos (geo/ISP/VPN de la IP + lo que mandó el
// navegador) y se lo reporta a monitoring — nunca le da a monitoring acceso
// a la base de negocio, solo le pasa este mensaje por HTTP con un secreto
// compartido. Si no hay MONITORING_INTAKE_URL configurada (aún no
// desplegado), no hace nada — nunca rompe el flujo de baneo por esto.
async function reportarIntento({ ip, telefono, agente, motivo, req, severity = 'high' }) {
  const url = process.env.MONITORING_INTAKE_URL;
  const secret = process.env.MONITORING_INTAKE_SECRET;
  if (!url || !secret) return;

  try {
    const [geo, identificacion] = [
      ip ? await consultarIP(ip) : null,
      req ? identificacionDeRequest(req) : {},
    ];

    const details = {
      canal: ip ? 'chat_web' : 'whatsapp',
      agente,
      motivo,
      telefono: telefono || null,
      ...identificacion,
      geo, // null si no hubo IP (WhatsApp) o si ip-api falló — nunca inventado
    };

    await fetch(`${url.replace(/\/$/, '')}/internal/report-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Intake-Secret': secret },
      body: JSON.stringify({
        event_type: 'unusual_access',
        severity,
        source_ip: ip || null,
        details,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('[ipIntel] Error reportando a monitoring (no afecta el baneo):', e.message);
  }
}

module.exports = { consultarIP, identificacionDeRequest, reportarIntento };
