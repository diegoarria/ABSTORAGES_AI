// ─── SARA.JS — Chat con SARA (AI Vendedora) ──────────────────────────────────

const Sara = (() => {
  let sessionId = App.generateSessionId();
  let isStreaming = false;
  let currentStreamDiv = null;
  let chatCerrado = false;

  function init() {
    document.getElementById('sara-session-id').textContent = sessionId;

    document.getElementById('sara-send').addEventListener('click', enviarMensaje);
    document.getElementById('sara-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        enviarMensaje();
      }
    });

    // Auto-resize textarea
    const input = document.getElementById('sara-input');
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    });

    document.getElementById('sara-new-session').addEventListener('click', nuevaSesion);
    document.getElementById('sara-clear-chat').addEventListener('click', limpiarChat);
  }

  async function enviarMensaje() {
    const input = document.getElementById('sara-input');
    const mensaje = input.value.trim();
    if (!mensaje || isStreaming || chatCerrado) return;

    input.value = '';
    input.style.height = 'auto';

    agregarMensajeUsuario(mensaje);
    mostrarTyping();
    window.CentroMando?.onUserMessage(mensaje);

    const btnSend = document.getElementById('sara-send');
    btnSend.disabled = true;
    isStreaming = true;

    try {
      const res = await fetch('/api/sara/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: mensaje, sessionId }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`Error HTTP ${res.status}`);
      }

      quitarTyping();
      const streamDiv = iniciarBurbujaSara();
      currentStreamDiv = streamDiv;

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
              const cleanText = textoAcumulado
                .replace(/NUEVA_ORDEN\s*:\s*\{[\s\S]*?\}/gi, '')
                .replace(/CERRAR_CHAT/gi, '')
                .replace(/ESCALAR_HUMANO/gi, '')
                .trim();
              streamDiv.innerHTML = renderMarkdown(cleanText);
              scrollToBottom('sara-messages');
            }

            if (data.type === 'nueva_orden') {
              const d = data.datos || {};
              App.toast(`Orden ${d.folio || ''} enviada a SOFIA`, 'verde', 4000);
              window.CentroMando?.onLeadComplete(d);
              // Replace streaming bubble with professional order card
              const cleanMsg = textoAcumulado.replace(/NUEVA_ORDEN\s*:\s*\{[\s\S]*?\}/gi, '').trim();
              streamDiv.innerHTML = renderMarkdown(cleanMsg) + renderOrdenCard(d);
              scrollToBottom('sara-messages');
              // Handoff automático: SOFIA recibe todos los datos y arranca operación
              if (data.datos) {
                document.dispatchEvent(new CustomEvent('nueva_orden_recibida', { detail: data.datos }));
              }
            }

            if (data.type === 'cerrar_chat') cerrarChat(streamDiv, textoAcumulado);
            if (data.type === 'escalar_humano') notificarEscalacion(streamDiv);

            if (data.type === 'error') {
              streamDiv.innerHTML = `<em style="color: var(--rojo)">Error: ${App.escapeHtml(data.message)}</em>`;
            }

            if (data.type === 'done') break;
          } catch (e) { /* ignorar líneas malformadas */ }
        }
      }
      window.CentroMando?.onSaraResponse(textoAcumulado);
      window.Features?.speakResponse(textoAcumulado, 'sara');
    } catch (err) {
      quitarTyping();
      agregarMensajeError('sara', 'No se pudo conectar con SARA. ¿El servidor está corriendo?');
      console.error('[SARA] Error:', err);
    } finally {
      isStreaming = false;
      btnSend.disabled = false;
      currentStreamDiv = null;
      input.focus();
    }
  }

  function agregarMensajeUsuario(texto) {
    const messages = document.getElementById('sara-messages');
    const div = document.createElement('div');
    div.className = 'message user';
    div.innerHTML = `
      <div class="message-avatar user">Tú</div>
      <div class="message-bubble">${App.escapeHtml(texto)}</div>
    `;
    messages.appendChild(div);
    scrollToBottom('sara-messages');
  }

  function mostrarTyping() {
    const messages = document.getElementById('sara-messages');
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.id = 'sara-typing';
    div.innerHTML = `
      <div class="message-avatar sara">S</div>
      <div class="message-bubble">
        <div class="typing-indicator">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
      </div>
    `;
    messages.appendChild(div);
    scrollToBottom('sara-messages');
  }

  function quitarTyping() {
    document.getElementById('sara-typing')?.remove();
  }

  function iniciarBurbujaSara() {
    const messages = document.getElementById('sara-messages');
    const div = document.createElement('div');
    div.className = 'message assistant';
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar sara';
    avatar.textContent = 'S';
    div.appendChild(avatar);
    div.appendChild(bubble);
    messages.appendChild(div);
    scrollToBottom('sara-messages');
    return bubble;
  }

  function agregarMensajeError(agente, texto) {
    const messages = document.getElementById(`${agente}-messages`);
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.innerHTML = `
      <div class="message-avatar ${agente}">${agente[0].toUpperCase()}</div>
      <div class="message-bubble" style="border-color: var(--rojo-dim)">
        <em style="color: var(--rojo)">${App.escapeHtml(texto)}</em>
      </div>
    `;
    messages.appendChild(div);
    scrollToBottom(`${agente}-messages`);
  }

  function cerrarChat(streamDiv, textoAcumulado) {
    // Limpiar señal técnica del texto visible
    if (streamDiv) {
      const cleanText = (textoAcumulado || '').replace(/CERRAR_CHAT/gi, '').trim();
      streamDiv.innerHTML = renderMarkdown(cleanText);
    }
    chatCerrado = true;
    const input = document.getElementById('sara-input');
    const btnSend = document.getElementById('sara-send');
    if (input) { input.disabled = true; input.placeholder = 'Chat cerrado'; }
    if (btnSend) btnSend.disabled = true;

    // Banner de cierre
    const messages = document.getElementById('sara-messages');
    const banner = document.createElement('div');
    banner.style.cssText = 'text-align:center;padding:10px;color:var(--texto-dim);font-size:.8em;border-top:1px solid var(--borde);margin-top:8px;';
    banner.textContent = '— Chat finalizado —';
    messages.appendChild(banner);
    scrollToBottom('sara-messages');
  }

  function notificarEscalacion(streamDiv) {
    if (streamDiv) {
      const cleanText = streamDiv.textContent.replace(/ESCALAR_HUMANO/gi, '').trim();
      streamDiv.innerHTML = renderMarkdown(cleanText);
    }
    App.toast('Escalado a equipo humano — alguien te contactará pronto', 'azul', 5000);
  }

  function nuevaSesion() {
    sessionId = App.generateSessionId();
    chatCerrado = false;
    document.getElementById('sara-session-id').textContent = sessionId;
    const input = document.getElementById('sara-input');
    const btnSend = document.getElementById('sara-send');
    if (input) { input.disabled = false; input.placeholder = ''; }
    if (btnSend) btnSend.disabled = false;
    limpiarChat();
    App.toast('Nueva sesión SARA iniciada', 'verde', 2000);
  }

  function limpiarChat() {
    const messages = document.getElementById('sara-messages');
    messages.innerHTML = `
      <div class="message assistant">
        <div class="message-avatar sara">S</div>
        <div class="message-bubble">
          <p>¡Hola! Soy <strong>SARA</strong>, ejecutiva comercial de <strong>ABSTORAGES Logistics Solutions</strong>.</p>
          <p>¿Con quién tengo el gusto y de qué empresa me contactas?</p>
        </div>
      </div>
    `;
  }

  function scrollToBottom(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    // Doble RAF: el primer frame aplica el DOM, el segundo lee scrollHeight ya actualizado
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    }));
  }

  // ── Orden confirmada — tarjeta profesional ────────────────────────────────
  function renderOrdenCard(d) {
    const fmt = (v) => v || '—';
    const folio = fmt(d.folio);
    const now = new Date().toLocaleDateString('es-MX', { day:'2-digit', month:'long', year:'numeric' });

    return `
<div class="orden-card">
  <div class="orden-card-header">
    <div class="orden-card-badge">
      <span class="orden-check">✓</span>
      <span>ORDEN CONFIRMADA</span>
    </div>
    <div class="orden-folio">${App.escapeHtml(folio)}</div>
  </div>

  <div class="orden-section">
    <div class="orden-row-2">
      <div class="orden-field">
        <div class="orden-label">👤 Cliente</div>
        <div class="orden-value">${App.escapeHtml(fmt(d.cliente))}</div>
      </div>
      <div class="orden-field">
        <div class="orden-label">🏢 Empresa</div>
        <div class="orden-value">${App.escapeHtml(fmt(d.empresa))}</div>
      </div>
    </div>
    <div class="orden-row-2">
      <div class="orden-field">
        <div class="orden-label">📞 Teléfono</div>
        <div class="orden-value">${App.escapeHtml(fmt(d.telefono))}</div>
      </div>
      <div class="orden-field">
        <div class="orden-label">✉️ Email</div>
        <div class="orden-value">${App.escapeHtml(fmt(d.email))}</div>
      </div>
    </div>
  </div>

  <div class="orden-divider"></div>

  <div class="orden-section">
    <div class="orden-field full">
      <div class="orden-label">📍 Ruta</div>
      <div class="orden-value ruta">${App.escapeHtml(fmt(d.ruta || (d.origen && d.destino ? d.origen + ' → ' + d.destino : null)))}</div>
    </div>
    <div class="orden-row-3">
      <div class="orden-field">
        <div class="orden-label">🚚 Unidad</div>
        <div class="orden-value">${App.escapeHtml(fmt(d.tipo_unidad))}</div>
      </div>
      <div class="orden-field">
        <div class="orden-label">📅 Fecha</div>
        <div class="orden-value">${App.escapeHtml(fmt(d.fecha_carga))}</div>
      </div>
      <div class="orden-field">
        <div class="orden-label">⚖️ Peso</div>
        <div class="orden-value">${App.escapeHtml(fmt(d.peso_toneladas))} ton</div>
      </div>
    </div>
    <div class="orden-row-2">
      <div class="orden-field">
        <div class="orden-label">📦 Tipo de carga</div>
        <div class="orden-value">${App.escapeHtml(fmt(d.tipo_carga))}</div>
      </div>
      <div class="orden-field">
        <div class="orden-label">🏷️ Mercancía</div>
        <div class="orden-value">${App.escapeHtml(fmt(d.descripcion_carga))}</div>
      </div>
    </div>
    ${d.requisitos ? `
    <div class="orden-field full">
      <div class="orden-label">⚠️ Requisitos especiales</div>
      <div class="orden-value">${App.escapeHtml(d.requisitos)}</div>
    </div>` : ''}
  </div>

  <div class="orden-divider"></div>

  <div class="orden-section">
    <div class="orden-row-2">
      <div class="orden-field">
        <div class="orden-label">🧾 RFC</div>
        <div class="orden-value">${App.escapeHtml(fmt(d.rfc))}</div>
      </div>
      <div class="orden-field">
        <div class="orden-label">📆 Registrada</div>
        <div class="orden-value">${now}</div>
      </div>
    </div>
  </div>

  <div class="orden-footer">
    <div class="orden-footer-brand">ABSTORAGES Logistics Solutions</div>
    <div class="orden-footer-status">
      <span class="orden-status-dot"></span>
      Enviada a operaciones · SOFIA en proceso
    </div>
  </div>
</div>`;
  }

  // Markdown mínimo: negrita, cursiva, código, listas
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
