import { Fragment, ReactNode, useEffect, useState } from 'react';
import { api, SecurityEvent } from '../api';

const SEVERIDADES = ['', 'low', 'medium', 'high', 'critical'];
const TIPOS = ['', 'failed_login', 'unusual_access', 'rls_violation', 'rate_limit_spike', 'other'];

interface Geo {
  ip?: string; pais?: string; codigoPais?: string; region?: string; ciudad?: string;
  codigoPostal?: string; latitud?: number; longitud?: number; zonaHoraria?: string;
  isp?: string; organizacion?: string; asn?: string; asnNombre?: string;
  esMovil?: boolean; posibleProxyOVpn?: boolean; posibleHostingODatacenter?: boolean;
  fuente?: string; consultadoEn?: string;
}
interface Detalle {
  canal?: string; agente?: string; motivo?: string; telefono?: string | null;
  userAgent?: string; referrer?: string; idioma?: string; geo?: Geo | null;
  [k: string]: unknown;
}

function Campo({ label, value }: { label: string; value: ReactNode }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 12, padding: '3px 0' }}>
      <span style={{ color: '#8b92a3', minWidth: 130 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function DetalleIdentificacion({ d }: { d: Detalle }) {
  const geo = d.geo || null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, padding: '8px 4px' }}>
      <div>
        <div style={{ fontSize: 11, color: '#8b92a3', textTransform: 'uppercase', marginBottom: 6 }}>Conexión</div>
        <Campo label="Canal" value={d.canal} />
        <Campo label="Agente" value={d.agente?.toUpperCase()} />
        <Campo label="Teléfono" value={d.telefono} />
        <Campo label="Motivo / mensaje" value={d.motivo} />
        <Campo label="URL de origen" value={d.referrer} />
        <Campo label="Idioma navegador" value={d.idioma} />
        <Campo label="Dispositivo (User-Agent)" value={d.userAgent ? <span style={{ wordBreak: 'break-all' }}>{d.userAgent}</span> : null} />
      </div>
      {geo && (
        <div>
          <div style={{ fontSize: 11, color: '#8b92a3', textTransform: 'uppercase', marginBottom: 6 }}>
            Geolocalización de la IP (fuente: {geo.fuente || 'desconocida'})
          </div>
          <Campo label="IP" value={geo.ip} />
          <Campo label="Empresa / ISP" value={geo.isp} />
          <Campo label="Organización" value={geo.organizacion} />
          <Campo label="ASN" value={geo.asn ? `${geo.asn}${geo.asnNombre ? ` (${geo.asnNombre})` : ''}` : null} />
          <Campo label="Ciudad" value={geo.ciudad} />
          <Campo label="Región / Estado" value={geo.region} />
          <Campo label="País" value={geo.pais ? `${geo.pais}${geo.codigoPais ? ` (${geo.codigoPais})` : ''}` : null} />
          <Campo label="Código postal" value={geo.codigoPostal} />
          <Campo label="Zona horaria" value={geo.zonaHoraria} />
          <Campo label="Coordenadas" value={geo.latitud != null ? `${geo.latitud}, ${geo.longitud}` : null} />
          <Campo label="¿Red móvil?" value={geo.esMovil ? 'Sí' : 'No'} />
          <Campo
            label="¿VPN/Proxy?"
            value={
              <span className={`pill pill-${geo.posibleProxyOVpn ? 'high' : 'ok'}`}>
                {geo.posibleProxyOVpn ? 'Señal detectada' : 'Sin señal'}
              </span>
            }
          />
          <Campo
            label="¿Hosting/Datacenter?"
            value={
              <span className={`pill pill-${geo.posibleHostingODatacenter ? 'medium' : 'ok'}`}>
                {geo.posibleHostingODatacenter ? 'Sí (posible bot/automatizado)' : 'No'}
              </span>
            }
          />
          <div style={{ fontSize: 11, color: '#8b92a3', marginTop: 8, maxWidth: 340 }}>
            Ciudad/región es la ubicación registrada del ISP, no un GPS exacto. VPN/Proxy es una señal
            heurística de {geo.fuente || 'la fuente'} — un "Sin señal" no garantiza que no sea VPN.
          </div>
        </div>
      )}
      {!geo && d.canal === 'whatsapp' && (
        <div style={{ fontSize: 12, color: '#8b92a3' }}>
          Sin geolocalización — WhatsApp no expone la IP del remitente, solo el teléfono.
        </div>
      )}
    </div>
  );
}

export default function SecurityEvents() {
  const [eventos, setEventos] = useState<SecurityEvent[]>([]);
  const [severity, setSeverity] = useState('');
  const [type, setType] = useState('');
  const [abierto, setAbierto] = useState<string | null>(null);
  const [verJson, setVerJson] = useState<string | null>(null);

  useEffect(() => {
    api.securityEvents({ severity: severity || undefined, type: type || undefined }).then(setEventos).catch(() => setEventos([]));
  }, [severity, type]);

  return (
    <div>
      <h2>Eventos de seguridad</h2>
      <div className="filters">
        <select value={severity} onChange={e => setSeverity(e.target.value)}>
          {SEVERIDADES.map(s => <option key={s} value={s}>{s || 'Todas las severidades'}</option>)}
        </select>
        <select value={type} onChange={e => setType(e.target.value)}>
          {TIPOS.map(t => <option key={t} value={t}>{t || 'Todos los tipos'}</option>)}
        </select>
      </div>
      {!eventos.length ? <div className="empty">Sin eventos con estos filtros.</div> : (
        <table>
          <thead>
            <tr><th>Fecha</th><th>Tipo</th><th>Severidad</th><th>IP / Teléfono</th><th>Empresa / ISP</th><th>Ciudad</th><th></th></tr>
          </thead>
          <tbody>
            {eventos.map(ev => {
              const d = (ev.details || {}) as Detalle;
              const geo = d.geo || null;
              return (
                <Fragment key={ev.id}>
                  <tr>
                    <td>{new Date(ev.detected_at).toLocaleString('es-MX')}</td>
                    <td>{ev.event_type}</td>
                    <td><span className={`pill pill-${ev.severity}`}>{ev.severity}</span></td>
                    <td>{ev.source_ip || d.telefono || '—'}</td>
                    <td>{geo?.isp || '—'}</td>
                    <td>{geo?.ciudad ? `${geo.ciudad}, ${geo.codigoPais || ''}` : '—'}</td>
                    <td><a onClick={() => setAbierto(abierto === ev.id ? null : ev.id)} style={{ cursor: 'pointer', color: '#60a5fa' }}>{abierto === ev.id ? 'ocultar' : 'detalle'}</a></td>
                  </tr>
                  {abierto === ev.id && (
                    <tr>
                      <td colSpan={7}>
                        <DetalleIdentificacion d={d} />
                        <details style={{ marginTop: 4 }} onToggle={e => setVerJson(e.currentTarget.open ? ev.id : null)}>
                          <summary>JSON crudo</summary>
                          {verJson === ev.id && <pre>{JSON.stringify(ev.details, null, 2)}</pre>}
                        </details>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
