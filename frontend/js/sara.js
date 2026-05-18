// ─── SARA.JS — Chat con SARA (AI Vendedora) ──────────────────────────────────

const Sara = (() => {
  let sessionId = App.generateSessionId();
  let isStreaming = false;
  let currentStreamDiv = null;

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
    if (!mensaje || isStreaming) return;

    input.value = '';
    input.style.height = 'auto';

    agregarMensajeUsuario(mensaje);
    mostrarTyping();

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
              streamDiv.innerHTML = renderMarkdown(textoAcumulado);
              scrollToBottom('sara-messages');
            }

            if (data.type === 'nueva_orden') {
              App.toast(`Nueva orden publicada a SOFIA: ${data.datos?.folio || ''}`, 'verde');
            }

            if (data.type === 'error') {
              streamDiv.innerHTML = `<em style="color: var(--rojo)">Error: ${App.escapeHtml(data.message)}</em>`;
            }

            if (data.type === 'done') break;
          } catch (e) { /* ignorar líneas malformadas */ }
        }
      }
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

  function nuevaSesion() {
    sessionId = App.generateSessionId();
    document.getElementById('sara-session-id').textContent = sessionId;
    limpiarChat();
    App.toast('Nueva sesión SARA iniciada', 'verde', 2000);
  }

  function limpiarChat() {
    const messages = document.getElementById('sara-messages');
    messages.innerHTML = `
      <div class="message assistant">
        <div class="message-avatar sara">S</div>
        <div class="message-bubble">
          <p>¡Hola! Soy <strong>SARA</strong>, la AI Vendedora de ABSTORAGES Logistics Solutions.</p>
          <p>Estoy lista para prospectar clientes, generar cotizaciones, negociar contratos y cerrar ventas. ¿En qué te puedo ayudar?</p>
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
