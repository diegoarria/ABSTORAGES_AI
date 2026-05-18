// ─── SOFIA.JS — Chat con SOFIA (AI Planner) ──────────────────────────────────

const Sofia = (() => {
  let sessionId = App.generateSessionId();
  let isStreaming = false;

  function init() {
    document.getElementById('sofia-session-id').textContent = sessionId;

    document.getElementById('sofia-send').addEventListener('click', enviarMensaje);
    document.getElementById('sofia-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        enviarMensaje();
      }
    });

    const input = document.getElementById('sofia-input');
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    });

    document.getElementById('sofia-new-session').addEventListener('click', nuevaSesion);
    document.getElementById('sofia-clear-chat').addEventListener('click', limpiarChat);

    // Escuchar eventos de nueva_orden de Redis (via SSE del servidor)
    escucharNuevaOrden();
  }

  async function enviarMensaje() {
    const input = document.getElementById('sofia-input');
    const mensaje = input.value.trim();
    if (!mensaje || isStreaming) return;

    input.value = '';
    input.style.height = 'auto';

    agregarMensajeUsuario(mensaje);
    mostrarTyping();

    const btnSend = document.getElementById('sofia-send');
    btnSend.disabled = true;
    isStreaming = true;

    try {
      const res = await fetch('/api/sofia/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: mensaje, sessionId }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`Error HTTP ${res.status}`);
      }

      quitarTyping();
      const streamDiv = iniciarBurbujaSofia();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let textoAcumulado = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lineas = buffer.split('\n\n');
        buffer = lineas.pop();

        for (const linea of lineas) {
          if (!linea.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(linea.slice(6));

            if (data.type === 'chunk') {
              textoAcumulado += data.text;
              streamDiv.innerHTML = renderMarkdown(textoAcumulado);
              scrollToBottom('sofia-messages');
            }

            if (data.type === 'folio_update') {
              App.toast(`Folio ${data.folio} → ${data.estatus}`, 'azul', 3000);
            }

            if (data.type === 'error') {
              streamDiv.innerHTML = `<em style="color: var(--rojo)">Error: ${App.escapeHtml(data.message)}</em>`;
            }

            if (data.type === 'done') break;
          } catch (e) { /* ignorar */ }
        }
      }
    } catch (err) {
      quitarTyping();
      agregarMensajeError('No se pudo conectar con SOFIA. ¿El servidor está corriendo?');
      console.error('[SOFIA] Error:', err);
    } finally {
      isStreaming = false;
      btnSend.disabled = false;
      input.focus();
    }
  }

  function escucharNuevaOrden() {
    // El servidor ya re-broadcast los eventos Redis via SSE en /api/actividad/stream
    // Sofia recibe notificación visual cuando SARA publica nueva_orden
    document.addEventListener('nueva_orden_recibida', (e) => {
      const orden = e.detail;
      App.toast(`SOFIA recibió nueva orden: ${orden.folio}`, 'azul');
      // Inyectar mensaje automático en chat de Sofia
      const messages = document.getElementById('sofia-messages');
      const div = document.createElement('div');
      div.className = 'message assistant';
      div.innerHTML = `
        <div class="message-avatar sofia">S</div>
        <div class="message-bubble" style="border-color: rgba(74,158,255,0.3)">
          <p><strong>Nueva orden recibida de SARA</strong></p>
          <p>Folio: <code>${App.escapeHtml(orden.folio || '')}</code></p>
          <p>Iniciando flujo de colocación de servicio automáticamente.</p>
        </div>
      `;
      messages.appendChild(div);
      scrollToBottom('sofia-messages');
    });
  }

  function agregarMensajeUsuario(texto) {
    const messages = document.getElementById('sofia-messages');
    const div = document.createElement('div');
    div.className = 'message user';
    div.innerHTML = `
      <div class="message-avatar user">Tú</div>
      <div class="message-bubble">${App.escapeHtml(texto)}</div>
    `;
    messages.appendChild(div);
    scrollToBottom('sofia-messages');
  }

  function mostrarTyping() {
    const messages = document.getElementById('sofia-messages');
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.id = 'sofia-typing';
    div.innerHTML = `
      <div class="message-avatar sofia">S</div>
      <div class="message-bubble">
        <div class="typing-indicator">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
      </div>
    `;
    messages.appendChild(div);
    scrollToBottom('sofia-messages');
  }

  function quitarTyping() {
    document.getElementById('sofia-typing')?.remove();
  }

  function iniciarBurbujaSofia() {
    const messages = document.getElementById('sofia-messages');
    const div = document.createElement('div');
    div.className = 'message assistant';
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar sofia';
    avatar.textContent = 'S';
    div.appendChild(avatar);
    div.appendChild(bubble);
    messages.appendChild(div);
    scrollToBottom('sofia-messages');
    return bubble;
  }

  function agregarMensajeError(texto) {
    const messages = document.getElementById('sofia-messages');
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.innerHTML = `
      <div class="message-avatar sofia">S</div>
      <div class="message-bubble" style="border-color: var(--rojo-dim)">
        <em style="color: var(--rojo)">${App.escapeHtml(texto)}</em>
      </div>
    `;
    messages.appendChild(div);
    scrollToBottom('sofia-messages');
  }

  function nuevaSesion() {
    sessionId = App.generateSessionId();
    document.getElementById('sofia-session-id').textContent = sessionId;
    limpiarChat();
    App.toast('Nueva sesión SOFIA iniciada', 'verde', 2000);
  }

  function limpiarChat() {
    const messages = document.getElementById('sofia-messages');
    messages.innerHTML = `
      <div class="message assistant">
        <div class="message-avatar sofia">S</div>
        <div class="message-bubble">
          <p>Hola, soy <strong>SOFIA</strong>, la AI Planner de ABSTORAGES Logistics Solutions.</p>
          <p>Gestiono la operación completa: busco transportistas, monitoreo viajes por GPS, coordino documentación ABCONTROL y manejo los folios de servicio. ¿Qué necesitas?</p>
        </div>
      </div>
    `;
  }

  function scrollToBottom(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    }));
  }

  function renderMarkdown(text) {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/^#{1,3}\s+(.+)/gm, '<strong>$1</strong>')
      .replace(/^[-•]\s+(.+)/gm, '• $1')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br/>')
      .replace(/^(.+)$/, '<p>$1</p>');
  }

  document.addEventListener('DOMContentLoaded', init);

  return {};
})();
