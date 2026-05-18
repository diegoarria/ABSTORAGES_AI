// ─── BROADCAST.JS — Panel de Campañas WhatsApp ────────────────────────────────

const Broadcast = (() => {
  let templates     = [];
  let currentId     = null;
  let pollTimer     = null;
  let historyLoaded = false;

  // ─── Init ─────────────────────────────────────────────────────────────────
  function init() {
    loadTemplates();
    document.getElementById('bc-template-select').addEventListener('change', onTemplateChange);
    document.getElementById('bc-recipients-input').addEventListener('input', onRecipientsChange);
    document.getElementById('bc-start-btn').addEventListener('click', startCampaign);
    document.getElementById('bc-cancel-btn').addEventListener('click', cancelCampaign);
    document.getElementById('bc-history-btn').addEventListener('click', toggleHistory);
    document.getElementById('bc-new-btn').addEventListener('click', resetPanel);
  }

  // ─── Cargar plantillas del servidor ──────────────────────────────────────
  async function loadTemplates() {
    try {
      templates = await fetch('/api/broadcast/templates').then(r => r.json());
      const sel = document.getElementById('bc-template-select');
      sel.innerHTML = '';
      templates.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `${t.agente.toUpperCase()} · ${t.nombre}`;
        sel.appendChild(opt);
      });
      onTemplateChange();
    } catch (e) { console.error('[Broadcast] Error cargando templates:', e); }
  }

  // ─── Cambio de plantilla ──────────────────────────────────────────────────
  function onTemplateChange() {
    const id = document.getElementById('bc-template-select').value;
    const t  = templates.find(x => x.id === id);
    if (!t) return;

    document.getElementById('bc-preview-text').textContent = t.preview;
    document.getElementById('bc-descripcion').textContent  = t.descripcion;

    const hint = `telefono, ${t.variables.join(', ')}`;
    document.getElementById('bc-cols-hint').textContent          = `Columnas: ${hint}`;
    document.getElementById('bc-recipients-input').placeholder   =
      `Pega aquí una columna por coma. Ejemplo:\n5215512345678, Rafael, ABST-001, 15 Jun, CDMX→MTY\n5215587654321, María, ABST-002, 16 Jun, GDL→MTY`;

    onRecipientsChange();
  }

  // ─── Parseo y conteo de destinatarios ────────────────────────────────────
  function parseRecipients() {
    const id  = document.getElementById('bc-template-select').value;
    const t   = templates.find(x => x.id === id);
    if (!t) return [];

    const raw   = document.getElementById('bc-recipients-input').value;
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

    return lines.map(line => {
      const parts = line.split(',').map(p => p.trim());
      const telefono  = parts[0] || '';
      const variables = parts.slice(1); // var1, var2, ... (en orden de la plantilla)
      const nombre    = variables[0] || telefono;
      return { nombre, telefono, variables };
    }).filter(d => d.telefono.match(/^\d{10,15}$/));
  }

  function onRecipientsChange() {
    const dests = parseRecipients();
    const raw   = document.getElementById('bc-recipients-input').value.trim();
    const total = raw.split('\n').filter(l => l.trim()).length;
    const valid = dests.length;

    document.getElementById('bc-count').textContent =
      total === 0  ? '' :
      valid === total ? `${valid} destinatario${valid !== 1 ? 's' : ''}` :
      `${valid} válidos de ${total} (revisa el formato)`;

    document.getElementById('bc-count').className =
      valid < total && total > 0 ? 'bc-count warn' : 'bc-count';

    document.getElementById('bc-start-btn').disabled = valid === 0;
  }

  // ─── Iniciar campaña ─────────────────────────────────────────────────────
  async function startCampaign() {
    const template     = document.getElementById('bc-template-select').value;
    const destinatarios = parseRecipients();
    if (!destinatarios.length) return;

    document.getElementById('bc-start-btn').disabled  = true;
    document.getElementById('bc-cancel-btn').style.display = 'inline-flex';
    document.getElementById('bc-form-area').style.display  = 'none';
    document.getElementById('bc-progress-area').style.display = 'block';

    setProgress(0, 0, 0, destinatarios.length, 'starting');

    try {
      const res = await fetch('/api/broadcast/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template, destinatarios }),
      }).then(r => r.json());

      if (!res.ok) throw new Error(res.error || 'Error al iniciar campaña');
      currentId = res.id;
      pollStatus();
    } catch (e) {
      App.toast('Error al iniciar campaña: ' + e.message, 'rojo', 4000);
      resetPanel();
    }
  }

  // ─── Polling de status ────────────────────────────────────────────────────
  function pollStatus() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (!currentId) return clearInterval(pollTimer);
      try {
        const c = await fetch(`/api/broadcast/status/${currentId}`).then(r => r.json());
        setProgress(c.progress, c.sent, c.errors, c.total, c.status);
        renderResults(c.results);

        if (['done', 'cancelled', 'error'].includes(c.status)) {
          clearInterval(pollTimer);
          document.getElementById('bc-cancel-btn').style.display = 'none';
          document.getElementById('bc-new-btn').style.display    = 'inline-flex';
          const msg = c.status === 'done'
            ? `Campaña enviada: ${c.sent} enviados, ${c.errors} errores`
            : `Campaña ${c.status}`;
          App.toast(msg, c.errors > 0 ? 'amber' : 'verde', 5000);
        }
      } catch (e) { console.error('[Broadcast] Poll error:', e); }
    }, 1200);
  }

  // ─── Cancelar ────────────────────────────────────────────────────────────
  async function cancelCampaign() {
    if (!currentId) return;
    await fetch(`/api/broadcast/cancel/${currentId}`, { method: 'POST' });
    App.toast('Campaña cancelada', 'amber', 3000);
  }

  // ─── Reset panel ─────────────────────────────────────────────────────────
  function resetPanel() {
    if (pollTimer) clearInterval(pollTimer);
    currentId = null;
    document.getElementById('bc-form-area').style.display      = 'block';
    document.getElementById('bc-progress-area').style.display  = 'none';
    document.getElementById('bc-cancel-btn').style.display     = 'none';
    document.getElementById('bc-new-btn').style.display        = 'none';
    document.getElementById('bc-start-btn').disabled           = false;
    document.getElementById('bc-recipients-input').value       = '';
    document.getElementById('bc-count').textContent            = '';
    document.getElementById('bc-results-body').innerHTML       = '';
  }

  // ─── UI helpers ──────────────────────────────────────────────────────────
  function setProgress(pct, sent, errors, total, status) {
    document.getElementById('bc-bar-fill').style.width = `${pct}%`;
    document.getElementById('bc-bar-fill').className   =
      'bc-bar-fill' + (errors > 0 ? ' has-errors' : '');

    const statusMap = {
      starting:  'Iniciando...',
      running:   `Enviando ${sent} / ${total}`,
      done:      `Completado — ${sent} enviados`,
      cancelled: `Cancelado — ${sent} enviados`,
      error:     'Error en la campaña',
    };
    document.getElementById('bc-status-text').textContent = statusMap[status] || status;

    const errEl = document.getElementById('bc-err-count');
    errEl.textContent = errors > 0 ? `${errors} error${errors !== 1 ? 'es' : ''}` : '';
    errEl.style.display = errors > 0 ? 'inline' : 'none';
  }

  function renderResults(results) {
    if (!results || !results.length) return;
    const tbody = document.getElementById('bc-results-body');
    tbody.innerHTML = results.map(r => `
      <tr class="bc-res-row ${r.status}">
        <td>${App.escapeHtml(r.nombre)}</td>
        <td class="bc-tel">${App.escapeHtml(r.telefono)}</td>
        <td class="bc-res-status ${r.status === 'ok' ? 'ok' : 'err'}">
          ${r.status === 'ok' ? '✓ Enviado' : '✗ Error'}
        </td>
        <td class="bc-ts">${new Date(r.ts).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
      </tr>`).join('');
    // Scroll al último resultado
    tbody.parentElement.scrollTop = tbody.parentElement.scrollHeight;
  }

  // ─── Historial ───────────────────────────────────────────────────────────
  async function toggleHistory() {
    const panel = document.getElementById('bc-history-panel');
    const isOpen = panel.style.display !== 'none';
    if (isOpen) {
      panel.style.display = 'none';
      document.getElementById('bc-history-btn').textContent = '📋 Historial';
      return;
    }
    panel.style.display = 'block';
    document.getElementById('bc-history-btn').textContent = '✕ Cerrar historial';
    try {
      const list = await fetch('/api/broadcast/campaigns').then(r => r.json());
      const tbody = document.getElementById('bc-history-body');
      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--texto3);padding:16px;">Sin campañas anteriores</td></tr>';
        return;
      }
      tbody.innerHTML = list.map(c => `
        <tr>
          <td class="bc-mono">${c.id}</td>
          <td>${c.template}</td>
          <td>${c.total}</td>
          <td class="bc-res-status ${c.status === 'done' ? 'ok' : c.status === 'running' ? '' : 'err'}">${c.status}</td>
          <td class="bc-ts">${new Date(c.createdAt).toLocaleString('es-MX', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
        </tr>`).join('');
    } catch (e) { console.error('[Broadcast] Historial error:', e); }
  }

  document.addEventListener('DOMContentLoaded', init);
  return { init };
})();
