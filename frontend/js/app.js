// ─── APP.JS — Lógica principal del portal ────────────────────────────────────

const App = (() => {
  // ─── TABS ─────────────────────────────────────────────────────────────────
  function initTabs() {
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        switchTab(tab);
      });
    });

    document.getElementById('btn-goto-sara')?.addEventListener('click', () => switchTab('sara'));
    document.getElementById('btn-goto-sofia')?.addEventListener('click', () => switchTab('sofia'));
  }

  function switchTab(tab) {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
  }

  // ─── MÉTRICAS ─────────────────────────────────────────────────────────────
  async function cargarMetricas() {
    try {
      const res = await fetch('/api/metricas');
      if (!res.ok) return;
      const data = await res.json();
      setMetrica('metric-folios-activos', data.folios_activos ?? 0);
      setMetrica('metric-folios-hoy', data.folios_hoy ?? 0);
      setMetrica('metric-proveedores', data.proveedores_activos ?? 0);
      setMetrica('metric-alertas', data.alertas_activas ?? 0);
    } catch (e) {
      console.warn('[App] Métricas no disponibles (¿DB configurada?)');
    }
  }

  function setMetrica(id, valor) {
    const el = document.getElementById(id);
    if (el) el.textContent = valor;
  }

  // ─── FOLIOS PIPELINE ──────────────────────────────────────────────────────
  async function cargarFolios() {
    try {
      const res = await fetch('/api/sofia/folios');
      if (!res.ok) return;
      const folios = await res.json();
      const counts = { PENDIENTE: 0, EN_BUSQUEDA: 0, PROGRAMADO: 0, EN_PROCESO: 0, ENTREGADO: 0, CONCLUIDO: 0 };
      folios.forEach((f) => { if (counts[f.estatus] !== undefined) counts[f.estatus]++; });
      setMetrica('stage-pendiente', counts.PENDIENTE);
      setMetrica('stage-busqueda', counts.EN_BUSQUEDA);
      setMetrica('stage-programado', counts.PROGRAMADO);
      setMetrica('stage-proceso', counts.EN_PROCESO);
      setMetrica('stage-entregado', counts.ENTREGADO);
      setMetrica('stage-concluido', counts.CONCLUIDO);
    } catch (e) {
      console.warn('[App] Folios no disponibles');
    }
  }

  document.getElementById('btn-refresh-folios')?.addEventListener('click', cargarFolios);

  // ─── SSE — ACTIVIDAD EN TIEMPO REAL ──────────────────────────────────────
  let sseConnection = null;

  function conectarActividadStream() {
    if (sseConnection) sseConnection.close();

    sseConnection = new EventSource('/api/actividad/stream');

    sseConnection.onopen = () => {
      document.getElementById('server-status')?.classList.add('online');
      document.getElementById('status-text').textContent = 'Conectado';
    };

    sseConnection.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'historial') {
          const log = document.getElementById('activity-log');
          log.innerHTML = '';
          data.actividades?.forEach((a) => agregarActividad(a, false));
        } else if (data.type === 'actividad') {
          agregarActividad(data, true);
          cargarMetricas();
        }
      } catch (err) {
        console.error('[SSE] Error parseando evento:', err);
      }
    };

    sseConnection.onerror = () => {
      document.getElementById('server-status')?.classList.remove('online');
      document.getElementById('status-text').textContent = 'Reconectando...';
      setTimeout(conectarActividadStream, 3000);
    };
  }

  function agregarActividad(evento, prepend = true) {
    const log = document.getElementById('activity-log');
    const empty = log.querySelector('.activity-empty');
    if (empty) empty.remove();

    const agente = (evento.agente || 'SISTEMA').toUpperCase();
    const agenteClass = agente === 'SARA' ? 'sara' : agente === 'SOFIA' ? 'sofia' : 'sistema';
    const itemClass = agente === 'SARA' ? 'sara' : agente === 'SOFIA' ? 'sofia' : '';
    const alertaClass = evento.tipo === 'ALERTA' || evento.tipo === 'ESCALADO' ? 'alerta' : '';

    const time = formatTime(evento.timestamp || evento.created_at);

    const item = document.createElement('div');
    item.className = `activity-item ${itemClass} ${alertaClass}`.trim();
    item.innerHTML = `
      <span class="activity-agent ${agenteClass}">${agente}</span>
      <span class="activity-msg">${escapeHtml(evento.mensaje || '')}</span>
      <span class="activity-time">${time}</span>
    `;

    if (prepend && log.firstChild) {
      log.insertBefore(item, log.firstChild);
    } else {
      log.appendChild(item);
    }

    // Limitar a 100 items
    while (log.children.length > 100) {
      log.removeChild(log.lastChild);
    }
  }

  // ─── HEALTH CHECK ─────────────────────────────────────────────────────────
  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        document.getElementById('server-status')?.classList.add('online');
        document.getElementById('status-text').textContent = 'Conectado';
      }
    } catch (e) {
      document.getElementById('server-status')?.classList.remove('online');
      document.getElementById('status-text').textContent = 'Desconectado';
    }
  }

  // ─── TOAST ────────────────────────────────────────────────────────────────
  function toast(mensaje, tipo = 'verde', duracion = 4000) {
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const el = document.createElement('div');
    el.className = `toast ${tipo}`;
    el.textContent = mensaje;
    container.appendChild(el);

    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      el.style.transition = 'all 0.2s';
      setTimeout(() => el.remove(), 200);
    }, duracion);
  }

  // ─── UTILS ────────────────────────────────────────────────────────────────
  function formatTime(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function generateSessionId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────
  function init() {
    initTabs();
    checkHealth();
    cargarMetricas();
    cargarFolios();
    conectarActividadStream();

    // Refrescar métricas cada 30s
    setInterval(cargarMetricas, 30000);
    setInterval(cargarFolios, 30000);
  }

  document.addEventListener('DOMContentLoaded', init);

  return { toast, generateSessionId, escapeHtml, formatTime, agregarActividad };
})();
