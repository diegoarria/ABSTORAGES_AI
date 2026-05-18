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

  // ─── KPIs ─────────────────────────────────────────────────────────────────
  const KPI_DATA = {
    sara: {
      llamadas_hoy    : 14,
      llamadas_meta   : 20,
      clientes_mes    : 3,
      venta_mes       : 284500,
      meta_mes        : 400000,
      pipeline: [
        { label: 'Nuevo contacto',    count: 12, color: '#7e8899', lightColor: '#374151' },
        { label: 'Cotización enviada',count: 8,  color: '#4a9eff', lightColor: '#1a6bbf' },
        { label: 'En negociación',    count: 5,  color: '#f5a623', lightColor: '#b45309' },
        { label: 'Cierre pendiente',  count: 3,  color: '#00e87a', lightColor: '#007a3d' },
        { label: 'Cerrado / ganado',  count: 7,  color: '#00e87a', lightColor: '#007a3d' },
      ],
    },
    sofia: {
      proveedores_mes  : 5,
      servicios_dia    : 4,
      servicios_mes    : 61,
      pipeline: [
        { label: 'Pendiente',    count: 2,  color: '#7e8899', lightColor: '#374151' },
        { label: 'En búsqueda', count: 3,  color: '#f5a623', lightColor: '#b45309' },
        { label: 'Programado',  count: 5,  color: '#4a9eff', lightColor: '#1a6bbf' },
        { label: 'En proceso',  count: 8,  color: '#00e87a', lightColor: '#007a3d' },
        { label: 'Entregado',   count: 4,  color: '#4a9eff', lightColor: '#1a6bbf' },
      ],
    },
  };

  function fmt(n) {
    if (n >= 1000000) return '$' + (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return '$' + (n / 1000).toFixed(0) + 'k';
    return '$' + n;
  }

  function renderKPIs() {
    const s = KPI_DATA.sara;
    const o = KPI_DATA.sofia;

    // SARA
    set('kpi-sara-llamadas', s.llamadas_hoy);
    set('kpi-sara-llamadas-sub', `Meta: ${s.llamadas_meta} llamadas`);
    set('kpi-sara-altas', s.clientes_mes);
    set('kpi-sara-venta', fmt(s.venta_mes));
    set('kpi-sara-meta',  fmt(s.meta_mes));
    const pct = Math.round((s.venta_mes / s.meta_mes) * 100);
    set('kpi-sara-pct', pct + '%');
    const bar = document.getElementById('kpi-sara-bar');
    if (bar) bar.style.width = Math.min(pct, 100) + '%';

    // Pipeline SARA
    const pipelineSara = document.getElementById('kpi-sara-pipeline');
    if (pipelineSara) pipelineSara.innerHTML = renderPipeline(s.pipeline);

    // SOFIA
    set('kpi-sofia-proveedores',   o.proveedores_mes);
    set('kpi-sofia-servicios-dia', o.servicios_dia);
    set('kpi-sofia-servicios-mes', o.servicios_mes);

    // Pipeline SOFIA
    const pipelineSofia = document.getElementById('kpi-sofia-pipeline');
    if (pipelineSofia) pipelineSofia.innerHTML = renderPipeline(o.pipeline);
  }

  function isLightTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light';
  }

  function renderPipeline(stages) {
    const light = isLightTheme();
    const max = Math.max(...stages.map(s => s.count), 1);
    return stages.map(s => {
      const c = light ? (s.lightColor || s.color) : s.color;
      return `
        <div class="kpi-pipe-row">
          <div class="kpi-pipe-label">${s.label}</div>
          <div class="kpi-pipe-track">
            <div class="kpi-pipe-fill" style="width:${Math.round((s.count / max) * 100)}%;background:${c}"></div>
          </div>
          <div class="kpi-pipe-count" style="color:${c}">${s.count}</div>
        </div>`;
    }).join('');
  }

  function set(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  // ─── LEADS ────────────────────────────────────────────────────────────────
  const LEADS_MOCK = [
    { hace: '19d', nombre: 'Rafael',           empresa: 'Bonafont',            ruta: 'Monterrey → México',      carga: 'general',       peso: '27t', tel: '8182594669' },
    { hace: '19d', nombre: 'Rafael',           empresa: 'Bonafont',            ruta: 'Monterrey → México',      carga: 'general',       peso: '27t', tel: '8182594669' },
    { hace: '24d', nombre: 'Alejandro Zapata', empresa: 'Marca Genérica',      ruta: 'Monterrey, NL → CDMX',   carga: 'general',       peso: '17t', tel: '+15736393679' },
    { hace: '28d', nombre: 'Luis Garza',       empresa: 'Frutas del Norte',    ruta: 'Monterrey → CDMX',       carga: 'carga general', peso: '18t', tel: '8112223344' },
    { hace: '28d', nombre: 'Maria Garcia',     empresa: 'Lácteos del Norte',   ruta: 'Monterrey → Guadalajara',carga: 'refrigerada',   peso: '15t', tel: '8198765432' },
    { hace: '28d', nombre: 'Pedro Martinez',   empresa: 'Alimentos del Norte', ruta: 'MTY, NL → Guadalajara',  carga: 'general',       peso: '20t', tel: '8187654321' },
    { hace: '28d', nombre: 'Rafael',           empresa: 'RJ',                  ruta: 'MTY, NL → Guadalajara',  carga: 'alimentos',     peso: '25t', tel: '8182594669' },
    { hace: '29d', nombre: 'Alex',             empresa: 'Vortex Agents',       ruta: 'Monterrey → Guadalajara',carga: 'general',       peso: '10t', tel: '+15736393679' },
    { hace: '29d', nombre: 'Daniel',           empresa: 'Vortex Agents',       ruta: 'Monterrey → Guadalajara',carga: 'general',       peso: '10t', tel: '+15736393679' },
    { hace: '30d', nombre: 'Daniel',           empresa: 'Vortex Agents',       ruta: 'Monterrey → CDMX',       carga: 'carga general', peso: '20t', tel: '8112345678' },
  ];

  function cargarLeads() {
    const tbody = document.getElementById('leads-tbody');
    const updatedEl = document.getElementById('leads-updated');
    if (!tbody) return;

    const now = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (updatedEl) updatedEl.textContent = `Actualizado ${now}`;

    tbody.innerHTML = LEADS_MOCK.map(l => `
      <tr>
        <td>${l.hace}</td>
        <td>${escapeHtml(l.nombre)}</td>
        <td>${escapeHtml(l.empresa)}</td>
        <td>${escapeHtml(l.ruta)}</td>
        <td>${escapeHtml(l.carga)}</td>
        <td>${l.peso}</td>
        <td>${l.tel}</td>
        <td><span class="badge-sent">sent</span></td>
      </tr>
    `).join('');
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────
  function init() {
    initTabs();
    checkHealth();
    cargarMetricas();
    cargarFolios();
    cargarLeads();
    renderKPIs();
    conectarActividadStream();

    // Re-renderizar pipelines cuando cambie el tema
    new MutationObserver(() => renderKPIs()).observe(
      document.documentElement,
      { attributes: true, attributeFilter: ['data-theme'] }
    );

    // Refrescar métricas cada 30s
    setInterval(cargarMetricas, 30000);
    setInterval(cargarFolios, 30000);
  }

  document.addEventListener('DOMContentLoaded', init);

  return { toast, generateSessionId, escapeHtml, formatTime, agregarActividad };
})();
