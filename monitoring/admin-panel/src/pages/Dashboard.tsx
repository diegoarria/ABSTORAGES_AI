import { useEffect, useState } from 'react';
import { api, ServiceStatus } from '../api';

const NOMBRES: Record<string, string> = {
  claude: 'Claude API', vapi: 'Vapi.ai', elevenlabs: 'ElevenLabs',
  whatsapp: 'WhatsApp (Twilio)', cliengo: 'Cliengo',
};

export default function Dashboard() {
  const [datos, setDatos] = useState<ServiceStatus[] | null>(null);

  useEffect(() => {
    const cargar = () => api.dashboard().then(setDatos).catch(() => setDatos([]));
    cargar();
    const t = setInterval(cargar, 30000); // refresca solo, cada 30s
    return () => clearInterval(t);
  }, []);

  if (!datos) return <div className="empty">Cargando…</div>;
  if (!datos.length) return <div className="empty">Todavía no hay checks — corre `npm run monitoring` para empezar a generar datos.</div>;

  return (
    <div>
      <h2>Estado de servicios</h2>
      <div className="grid">
        {datos.map(s => (
          <div className="card" key={s.service_name}>
            <div className="name">{NOMBRES[s.service_name] || s.service_name}</div>
            <span className={`pill pill-${s.status}`}>{s.status}</span>
            <div className="meta">Última vez: {new Date(s.checked_at).toLocaleString('es-MX')}</div>
            <div className="meta">Latencia: {s.latency_ms ?? '—'}ms · HTTP {s.status_code ?? '—'}</div>
            <div className="meta">Promedio 24h: {s.avg_latency_ms_24h ?? '—'}ms</div>
          </div>
        ))}
      </div>
    </div>
  );
}
