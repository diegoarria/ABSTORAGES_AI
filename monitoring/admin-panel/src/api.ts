// Todas las llamadas van con cookies (sesión propia del panel, ver
// monitoring/lib/adminAuth.js) — nunca al backend de negocio.
async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (r.status === 401) throw new ApiError('No autenticado', 401);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(data.error || `HTTP ${r.status}`, r.status);
  return data;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface ServiceStatus {
  service_name: string;
  status: 'ok' | 'degraded' | 'down';
  checked_at: string;
  latency_ms: number | null;
  status_code: number | null;
  avg_latency_ms_24h: number | null;
}

export interface SecurityEvent {
  id: string;
  detected_at: string;
  event_type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  source_ip: string | null;
  details: Record<string, unknown>;
}

export interface Incident {
  id: string;
  created_at: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary_text: string;
  related_event_ids: string[];
  resolved: boolean;
  resolved_at: string | null;
}

export interface Alert {
  id: string;
  incident_id: string;
  sent_at: string;
  channel: 'whatsapp' | 'email';
  delivery_status: string;
  summary_text: string;
  severity: string;
}

export const api = {
  login: (username: string, password: string) =>
    req<{ ok: true; username: string }>('/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => req('/logout', { method: 'POST' }),
  me: () => req<{ username: string }>('/me'),
  dashboard: () => req<ServiceStatus[]>('/dashboard'),
  securityEvents: (params: { severity?: string; type?: string } = {}) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return req<SecurityEvent[]>(`/security-events${qs ? `?${qs}` : ''}`);
  },
  incidents: () => req<Incident[]>('/incidents'),
  resolveIncident: (id: string) => req<Incident>(`/incidents/${id}/resolve`, { method: 'POST' }),
  alerts: () => req<Alert[]>('/alerts'),
};
