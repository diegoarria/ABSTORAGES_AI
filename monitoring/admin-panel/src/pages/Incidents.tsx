import { useEffect, useState } from 'react';
import { api, Incident } from '../api';

export default function Incidents() {
  const [incidentes, setIncidentes] = useState<Incident[] | null>(null);
  const [resolviendo, setResolviendo] = useState<string | null>(null);

  function cargar() {
    api.incidents().then(setIncidentes).catch(() => setIncidentes([]));
  }
  useEffect(cargar, []);

  async function resolver(id: string) {
    setResolviendo(id);
    try {
      await api.resolveIncident(id);
      cargar();
    } finally {
      setResolviendo(null);
    }
  }

  if (!incidentes) return <div className="empty">Cargando…</div>;

  return (
    <div>
      <h2>Incidentes</h2>
      {!incidentes.length ? <div className="empty">Sin incidentes registrados.</div> : (
        <table>
          <thead>
            <tr><th>Fecha</th><th>Severidad</th><th>Resumen</th><th>Estado</th><th></th></tr>
          </thead>
          <tbody>
            {incidentes.map(inc => (
              <tr key={inc.id}>
                <td>{new Date(inc.created_at).toLocaleString('es-MX')}</td>
                <td><span className={`pill pill-${inc.severity}`}>{inc.severity}</span></td>
                <td style={{ maxWidth: 480, whiteSpace: 'pre-wrap' }}>{inc.summary_text}</td>
                <td>{inc.resolved ? `Resuelto — ${new Date(inc.resolved_at!).toLocaleString('es-MX')}` : 'Abierto'}</td>
                <td>
                  {!inc.resolved && (
                    <button disabled={resolviendo === inc.id} onClick={() => resolver(inc.id)}>
                      {resolviendo === inc.id ? '...' : 'Marcar resuelto'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
