import { useEffect, useState } from 'react';
import { api, Alert } from '../api';

export default function Alerts() {
  const [alertas, setAlertas] = useState<Alert[] | null>(null);

  useEffect(() => { api.alerts().then(setAlertas).catch(() => setAlertas([])); }, []);

  if (!alertas) return <div className="empty">Cargando…</div>;
  if (!alertas.length) return <div className="empty">Sin alertas enviadas todavía.</div>;

  return (
    <div>
      <h2>Historial de alertas</h2>
      <table>
        <thead>
          <tr><th>Enviada</th><th>Canal</th><th>Severidad</th><th>Resumen</th><th>Estado de entrega</th></tr>
        </thead>
        <tbody>
          {alertas.map(a => (
            <tr key={a.id}>
              <td>{new Date(a.sent_at).toLocaleString('es-MX')}</td>
              <td>{a.channel}</td>
              <td><span className={`pill pill-${a.severity}`}>{a.severity}</span></td>
              <td style={{ maxWidth: 480, whiteSpace: 'pre-wrap' }}>{a.summary_text}</td>
              <td>{a.delivery_status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
