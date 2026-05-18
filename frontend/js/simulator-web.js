// ─── SIMULATOR-WEB.JS ─────────────────────────────────────────────────────────

const Sim = (() => {
  let saraSession = genId();
  let sofiaSession = genId();
  let saraStreaming = false;
  let sofiaStreaming = false;
  let folioCount = 1;

  // ─── ESCENARIOS ────────────────────────────────────────────────────────────
  const SCENARIOS = {
    1: {
      label: 'Cliente nuevo CDMX→MTY',
      sara: 'Hola, soy Carlos de Distribuidora Norteña. Necesito cotización urgente para mover 18 toneladas de abarrotes de CDMX a Monterrey, quiero caja seca 53\' para el jueves.',
    },
    2: {
      label: 'Cotización urgente 24h',
      sara: 'Buenos días, tenemos una carga urgente. Necesitamos un torton de Guadalajara a Querétaro para mañana a las 7 AM. ¿Tienen disponibilidad? ¿Cuánto cobran?',
    },
    3: {
      label: 'Búsqueda de transportista',
      sofia: 'Tengo el folio ABST-000099, ruta CDMX→Veracruz, caja seca 53\', para el lunes. Los 3 proveedores recurrentes no han respondido en 3 horas. ¿Qué hago ahora?',
    },
    4: {
      label: 'Alerta GPS en ruta',
      sofia: 'La unidad del folio ABST-000077 lleva 40 minutos detenida en la autopista México-Querétaro, a la altura de Tepeji del Río. El chofer no responde WhatsApp. ¿Qué protocolo ejecuto?',
    },
    5: {
      label: 'Recuperar cliente inactivo',
      sara: 'Tengo en la base al cliente "Grupo Textil Puebla" que no nos ha dado servicio en 3 meses. La última razón fue que consiguieron un precio más bajo con otro proveedor. ¿Cómo lo reactivamos?',
    },
  };

  // ─── INIT ──────────────────────────────────────────────────────────────────
  function init() {
    document.getElementById('sara-send').addEventListener('click', () => enviar('sara'));
    document.getElementById('sofia-send').addEventListener('click', () => enviar('sofia'));

    document.getElementById('sara-inp').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar('sara'); }
    });
    document.getElementById('sofia-inp').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar('sofia'); }
    });

    ['sara-inp', 'sofia-inp'].forEach((id) => {
      document.getElementById(id).addEventListener('input', autoResize);
    });

    document.querySelectorAll('.scenario-btn').forEach((btn) => {
      btn.addEventListener('click', () => correrEscenario(parseInt(btn.dataset.scenario)));
    });

    document.getElementById('btn-reset').addEventListener('click', resetear);
  }

  // ─── ENVIAR MENSAJE ────────────────────────────────────────────────────────
  async function enviar(agente) {
    const inputId = `${agente}-inp`;
    const input = document.getElementById(inputId);
    const msg = input.value.trim();
    if (!msg) return;
    if (agente === 'sara' && saraStreaming) return;
    if (agente === 'sofia' && sofiaStreaming) return;

    input.value = '';
    input.style.height = 'auto';

    agregarMsg(agente, 'user', msg);
    await streamRespuesta(agente, msg);
  }

  // ─── ESCENARIO ─────────────────────────────────────────────────────────────
  async function correrEscenario(num) {
    const s = SCENARIOS[num];
    if (!s) return;

    document.querySelectorAll('.scenario-btn').forEach(b => b.disabled = true);

    if (s.sara) {
      agregarMsg('sara', 'user', s.sara);
      await streamRespuesta('sara', s.sara);
    }
    if (s.sofia) {
      agregarMsg('sofia', 'user', s.sofia);
      await streamRespuesta('sofia', s.sofia);
    }

    document.querySelectorAll('.scenario-btn').forEach(b => b.disabled = false);
  }

  // ─── STREAM ────────────────────────────────────────────────────────────────
  async function streamRespuesta(agente, mensaje) {
    const session = agente === 'sara' ? saraSession : sofiaSession;
    const sendBtn = document.getElementById(`${agente}-send`);

    if (agente === 'sara') saraStreaming = true;
    else sofiaStreaming = true;
    sendBtn.disabled = true;

    mostrarTyping(agente);

    try {
      const res = await fetch(`/api/${agente}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: mensaje, sessionId: session }),
      });

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      quitarTyping(agente);
      const bubble = crearBurbuja(agente);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let texto = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n\n');
        buf = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'chunk') {
              texto += data.text;
              bubble.innerHTML = renderMd(texto);
              scroll(agente);
            }
            if (data.type === 'nueva_orden') {
              triggerEventBus(data.datos?.folio || `ABST-${String(folioCount++).padStart(6,'0')}`);
            }
          } catch(e) {}
        }
      }

      // Detectar cierre de venta en respuesta de SARA
      if (agente === 'sara' && detectarCierre(texto)) {
        const folio = `ABST-${String(folioCount++).padStart(6,'0')}`;
        triggerEventBus(folio);
        await autoSofiaReaccion(folio);
      }

    } catch (err) {
      quitarTyping(agente);
      agregarMsg(agente, 'assistant', `⚠️ Error de conexión. ¿El servidor está corriendo? (${err.message})`);
    } finally {
      if (agente === 'sara') saraStreaming = false;
      else sofiaStreaming = false;
      sendBtn.disabled = false;
    }
  }

  // ─── EVENT BUS ANIMATION ──────────────────────────────────────────────────
  function triggerEventBus(folio) {
    const bn1   = document.getElementById('bn1');
    const bn2   = document.getElementById('bn2');
    const ba1   = document.getElementById('ba1');
    const ba2   = document.getElementById('ba2');
    const label = document.getElementById('bus-folio');
    const flash = document.getElementById('bus-flash');

    bn1.classList.add('fire');
    bn2.classList.add('fire');
    ba1.classList.add('fire');
    ba2.classList.add('fire');
    label.classList.add('fire');
    label.textContent = folio;

    // flash overlay
    flash.classList.add('show');
    setTimeout(() => flash.classList.remove('show'), 300);

    // SARA notif
    const saraTxt = document.getElementById('sara-notif-txt');
    const saraBar = document.getElementById('sara-notif');
    saraTxt.textContent = `✓ nueva_orden publicada → ${folio}`;
    saraBar.classList.add('show');

    // SOFIA notif
    const sofiaTxt = document.getElementById('sofia-notif-txt');
    const sofiaBar = document.getElementById('sofia-notif');
    sofiaTxt.textContent = `← nueva_orden recibida: ${folio}`;
    sofiaBar.classList.add('show');

    setTimeout(() => {
      bn1.classList.remove('fire');
      bn2.classList.remove('fire');
      ba1.classList.remove('fire');
      ba2.classList.remove('fire');
      label.classList.remove('fire');
      label.innerHTML = 'Redis<br/>Pub/Sub';
    }, 3500);
  }

  // ─── AUTO REACCION SOFIA ──────────────────────────────────────────────────
  async function autoSofiaReaccion(folio) {
    const msgSofia = `Acabo de recibir una nueva orden de SARA. Folio: ${folio}. Ejecuta el Paso 1 del Flujo Primario: confirma recepción del requerimiento y describe brevemente los próximos 2 pasos que harás para colocar el servicio.`;

    await delay(800);
    agregarMsg('sofia', 'user', `[sistema] nueva_orden: ${folio}`);
    await streamRespuesta('sofia', msgSofia);
  }

  // ─── DETECCIÓN CIERRE ─────────────────────────────────────────────────────
  function detectarCierre(texto) {
    const kw = ['confirmo el servicio','venta cerrada','servicio registrado','folio','notifico a sofia','pasando a sofia','informo a sofia','registro el servicio','cierro el servicio','orden generada','servicio queda confirmado'];
    const t = texto.toLowerCase();
    return kw.some(k => t.includes(k));
  }

  // ─── UI HELPERS ───────────────────────────────────────────────────────────
  function agregarMsg(agente, rol, texto) {
    const msgs = document.getElementById(`${agente}-msgs`);
    const div = document.createElement('div');
    div.className = `msg ${rol}`;

    if (rol === 'user') {
      div.innerHTML = `
        <div class="msg-avatar user">Tú</div>
        <div class="msg-bubble">${esc(texto)}</div>
      `;
    } else {
      div.innerHTML = `
        <div class="msg-avatar ${agente}">${agente[0].toUpperCase()}</div>
        <div class="msg-bubble">${renderMd(texto)}</div>
      `;
    }

    msgs.appendChild(div);
    scroll(agente);
  }

  function mostrarTyping(agente) {
    const msgs = document.getElementById(`${agente}-msgs`);
    const div = document.createElement('div');
    div.className = 'msg assistant';
    div.id = `${agente}-typing`;
    div.innerHTML = `
      <div class="msg-avatar ${agente}">${agente[0].toUpperCase()}</div>
      <div class="msg-bubble"><div class="typing"><div class="t-dot"></div><div class="t-dot"></div><div class="t-dot"></div></div></div>
    `;
    msgs.appendChild(div);
    scroll(agente);
  }

  function quitarTyping(agente) {
    document.getElementById(`${agente}-typing`)?.remove();
  }

  function crearBurbuja(agente) {
    const msgs = document.getElementById(`${agente}-msgs`);
    const div = document.createElement('div');
    div.className = 'msg assistant';
    const bubbleId = `${agente}-stream-${Date.now()}`;
    div.innerHTML = `
      <div class="msg-avatar ${agente}">${agente[0].toUpperCase()}</div>
      <div class="msg-bubble" id="${bubbleId}"></div>
    `;
    msgs.appendChild(div);
    scroll(agente);
    return document.getElementById(bubbleId);
  }

  function scroll(agente) {
    const el = document.getElementById(`${agente}-msgs`);
    if (el) el.scrollTop = el.scrollHeight;
  }

  function autoResize(e) {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  }

  function resetear() {
    ['sara','sofia'].forEach(a => {
      document.getElementById(`${a}-msgs`).innerHTML = '';
      document.getElementById(`${a}-notif`).classList.remove('show');
    });
    saraSession = genId();
    sofiaSession = genId();
    folioCount = 1;

    agregarMsg('sara', 'assistant', '¡Hola! Soy **SARA**, la AI Vendedora de ABSTORAGES. ¿En qué te puedo ayudar?');
    agregarMsg('sofia', 'assistant', 'Soy **SOFIA**, la AI Planner. Escuchando el event bus — en cuanto SARA cierre una venta, actúo automáticamente.');
  }

  // ─── MARKDOWN BÁSICO ──────────────────────────────────────────────────────
  function renderMd(t) {
    return t
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/```([\s\S]*?)```/g,'<pre style="background:var(--s3);padding:8px;border-radius:6px;font-size:11px;overflow-x:auto;margin:6px 0;font-family:var(--mono)">$1</pre>')
      .replace(/`([^`]+)`/g,'<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,'<em>$1</em>')
      .replace(/^#{1,3}\s+(.+)/gm,'<strong>$1</strong>')
      .replace(/^[-•]\s+(.+)/gm,'• $1')
      .replace(/\n\n/g,'</p><p>')
      .replace(/\n/g,'<br>')
      .replace(/^(.+)$/,'<p>$1</p>');
  }

  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function genId() { return `sim-${Date.now()}-${Math.random().toString(36).slice(2,6)}`; }
  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  document.addEventListener('DOMContentLoaded', init);
  return {};
})();
