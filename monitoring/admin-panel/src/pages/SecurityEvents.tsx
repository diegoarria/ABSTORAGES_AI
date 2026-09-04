import { Fragment, useEffect, useState } from 'react';
import { api, SecurityEvent } from '../api';

const SEVERIDADES = ['', 'low', 'medium', 'high', 'critical'];
const TIPOS = ['', 'failed_login', 'unusual_access', 'rls_violation', 'rate_limit_spike', 'other'];

export default function SecurityEvents() {
  const [eventos, setEventos] = useState<SecurityEvent[]>([]);
  const [severity, setSeverity] = useState('');
  const [type, setType] = useState('');
  const [abierto, setAbierto] = useState<string | null>(null);

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
            <tr><th>Fecha</th><th>Tipo</th><th>Severidad</th><th>IP origen</th><th></th></tr>
          </thead>
          <tbody>
            {eventos.map(ev => (
              <Fragment key={ev.id}>
                <tr>
                  <td>{new Date(ev.detected_at).toLocaleString('es-MX')}</td>
                  <td>{ev.event_type}</td>
                  <td><span className={`pill pill-${ev.severity}`}>{ev.severity}</span></td>
                  <td>{ev.source_ip || '—'}</td>
                  <td><a onClick={() => setAbierto(abierto === ev.id ? null : ev.id)} style={{ cursor: 'pointer', color: '#60a5fa' }}>{abierto === ev.id ? 'ocultar' : 'detalle'}</a></td>
                </tr>
                {abierto === ev.id && (
                  <tr><td colSpan={5}><pre>{JSON.stringify(ev.details, null, 2)}</pre></td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
