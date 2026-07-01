// ─── FEATURES.JS — Voz, Micrófono, Alertas Predictivas, Tarifario ─────────────

const Features = (() => {

  // ── VOICE TTS (ElevenLabs) ────────────────────────────────────────────────
  let currentAudio = null;

  function playTTS(text, agente) {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }

    const clean = text.replace(/<[^>]+>/g, '').replace(/[*_`#>]/g, '').slice(0, 2500);

    return fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean, agente }),
    }).then(res => {
      if (!res.ok) return res.json().then(e => { throw new Error(e.hint || e.error); });
      return res.blob();
    }).then(blob => {
      const url = URL.createObjectURL(blob);
      currentAudio = new Audio(url);
      currentAudio.play();
      currentAudio.onended = () => URL.revokeObjectURL(url);
      return currentAudio;
    });
  }

  function addVoiceButton(bubble, agente) {
    const btn = document.createElement('button');
    btn.className = 'btn-tts';
    btn.title = 'Escuchar respuesta';
    btn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
      </svg>
    `;

    let playing = false;
    btn.addEventListener('click', () => {
      if (playing) {
        if (currentAudio) { currentAudio.pause(); currentAudio = null; }
        playing = false;
        btn.classList.remove('active');
        return;
      }
      playing = true;
      btn.classList.add('active');
      playTTS(bubble.textContent, agente)
        .then(audio => {
          if (audio) audio.onended = () => { playing = false; btn.classList.remove('active'); };
        })
        .catch(err => {
          playing = false;
          btn.classList.remove('active');
          if (err.message?.includes('ElevenLabs')) {
            App.toast('Voz no configurada — agrega ELEVENLABS_API_KEY al .env', 'amber', 5000);
          } else {
            App.toast('Error al reproducir voz', 'rojo', 3000);
          }
        });
    });

    const wrapper = bubble.closest('.message');
    if (wrapper) wrapper.appendChild(btn);
  }

  // Observar nuevas burbujas de assistant y agregarles botón de voz
  function watchBubbles() {
    const observer = new MutationObserver(mutations => {
      mutations.forEach(m => {
        m.addedNodes.forEach(node => {
          if (!(node instanceof Element)) return;
          // Directo: es un .message.assistant
          if (node.matches('.message.assistant')) attachVoice(node);
          // Descendiente
          node.querySelectorAll?.('.message.assistant').forEach(attachVoice);
        });
      });
    });

    ['sara-messages', 'sofia-messages'].forEach(id => {
      const el = document.getElementById(id);
      if (el) observer.observe(el, { childList: true, subtree: false });
    });
  }

  function attachVoice(msgEl) {
    if (msgEl.querySelector('.btn-tts')) return; // ya tiene botón
    const bubble = msgEl.querySelector('.message-bubble');
    if (!bubble) return;
    const agente = msgEl.closest('#sara-messages') ? 'sara' : 'sofia';
    // Esperar a que termine el streaming antes de hacer el botón interactivo
    const ro = new ResizeObserver(() => {
      if (bubble.textContent.trim().length > 20) {
        ro.disconnect();
        addVoiceButton(bubble, agente);
      }
    });
    ro.observe(bubble);
  }

  // ── MICROPHONE STT + VOICE CALL MODE ─────────────────────────────────────
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  // Qué agente habló por voz en el último mensaje (para auto-leer respuesta)
  const _voicePending = {};

  function initMic(inputId, btnId) {
    const btn = document.getElementById(btnId);
    const input = document.getElementById(inputId);
    if (!btn || !input) return;

    const agente = btnId.replace('-mic', ''); // 'sara' | 'sofia'
    const sendBtn = document.getElementById(btnId.replace('-mic', '-send'));

    if (!SpeechRecognition) {
      btn.disabled = true;
      btn.title = 'Tu navegador no soporta reconocimiento de voz';
      btn.style.opacity = '0.3';
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'es-MX';
    recognition.continuous = false;
    recognition.interimResults = true;

    let recording = false;
    let hasTranscript = false;

    btn.addEventListener('click', () => {
      if (recording) { recognition.stop(); return; }
      hasTranscript = false;
      // Detener TTS si estaba hablando
      window.speechSynthesis?.cancel();
      recognition.start();
    });

    recognition.onstart = () => {
      recording = true;
      btn.classList.add('recording');
      btn.title = 'Grabando... (clic para detener)';
    };

    recognition.onresult = e => {
      const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
      input.value = transcript;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
      hasTranscript = transcript.trim().length > 0;
    };

    recognition.onend = () => {
      recording = false;
      btn.classList.remove('recording');
      btn.title = 'Hablar con ' + agente.toUpperCase();
      // Auto-enviar si hubo transcripción
      if (hasTranscript && sendBtn && !sendBtn.disabled) {
        _voicePending[agente] = true;
        // Pequeño delay para que el navegador termine de escribir el resultado final
        setTimeout(() => sendBtn.click(), 80);
      }
    };

    recognition.onerror = (e) => {
      recording = false;
      btn.classList.remove('recording');
      if (e.error !== 'no-speech') {
        App.toast('Error de micrófono: ' + e.error, 'amber', 3000);
      }
    };
  }

  // ── TTS AUTOMÁTICO (browser speechSynthesis, sin API key) ─────────────────
  function speakResponse(text, agente) {
    if (!window.speechSynthesis) return;
    // Solo si el último mensaje de este agente fue por voz
    if (!_voicePending[agente]) return;
    _voicePending[agente] = false;

    window.speechSynthesis.cancel();
    const clean = text.replace(/<[^>]+>/g, '').replace(/[*_`#>]/g, '').slice(0, 3000);
    const utt = new SpeechSynthesisUtterance(clean);
    utt.lang = 'es-MX';
    utt.rate = 1.05;
    utt.pitch = agente === 'sara' ? 1.1 : 0.95;

    const loadVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      const preferred = voices.find(v => v.lang === 'es-MX' || v.lang === 'es-US' || v.lang.startsWith('es'));
      if (preferred) utt.voice = preferred;
      window.speechSynthesis.speak(utt);
    };

    // getVoices() puede estar vacío en primer uso — esperar el evento
    if (window.speechSynthesis.getVoices().length > 0) {
      loadVoice();
    } else {
      window.speechSynthesis.addEventListener('voiceschanged', loadVoice, { once: true });
    }
  }

  // ── CALL MODE ────────────────────────────────────────────────────────────
  let callActive    = false;
  let callSeconds   = 0;
  let callTimer     = null;
  let callRecog     = null;
  let callAudio     = null;
  let callAutoListen = false;

  function initCallMode() {
    const overlay  = document.getElementById('call-overlay');
    const micBtn   = document.getElementById('call-mic-btn');
    const endBtn   = document.getElementById('call-end-btn');
    const phoneBtn = document.getElementById('sara-mic');
    if (!overlay || !micBtn || !endBtn || !phoneBtn) return;

    phoneBtn.addEventListener('click', openCall);
    endBtn.addEventListener('click', closeCall);
    micBtn.addEventListener('click', () => {
      if (callRecog) {
        callAutoListen = false;
        callRecog.stop();
      } else {
        callAutoListen = false;
        callListen();
      }
    });
  }

  function openCall() {
    if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
      App.toast('Tu navegador no soporta reconocimiento de voz. Usa Chrome o Edge.', 'amber', 5000);
      return;
    }
    callActive   = true;
    callSeconds  = 0;
    const overlay = document.getElementById('call-overlay');
    overlay.style.display = 'flex';
    overlay.dataset.state  = 'idle';
    setCallStatus('Iniciando llamada...', 'idle');
    callTimer = setInterval(() => {
      callSeconds++;
      const m = String(Math.floor(callSeconds / 60)).padStart(1,'0');
      const s = String(callSeconds % 60).padStart(2,'0');
      const el = document.getElementById('call-timer');
      if (el) el.textContent = `${m}:${s}`;
    }, 1000);
    callAutoListen = true;
    setTimeout(callListen, 800);
  }

  function closeCall() {
    callActive     = false;
    callAutoListen = false;
    clearInterval(callTimer);
    if (callRecog)  { callRecog.stop(); callRecog = null; }
    if (callAudio)  { callAudio.pause(); callAudio = null; }
    const overlay = document.getElementById('call-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  function setCallStatus(text, state) {
    const overlay = document.getElementById('call-overlay');
    const status  = document.getElementById('call-status');
    if (overlay) overlay.dataset.state = state;
    if (status)  status.textContent = text;
  }

  function callListen() {
    if (!callActive) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = 'es-MX';
    rec.continuous = false;
    rec.interimResults = true;
    callRecog = rec;

    const micBtn = document.getElementById('call-mic-btn');
    if (micBtn) micBtn.classList.add('listening');
    setCallStatus('Escuchando...', 'listening');
    const tx = document.getElementById('call-transcript');
    if (tx) tx.textContent = '';

    let userText = '';

    rec.onresult = e => {
      userText = Array.from(e.results).map(r => r[0].transcript).join('');
      if (tx) tx.textContent = userText;
    };

    rec.onend = async () => {
      callRecog = null;
      if (micBtn) micBtn.classList.remove('listening');
      if (!callActive) return;
      if (!userText.trim()) {
        setCallStatus('No te escuché. Toca el micrófono para hablar.', 'idle');
        if (tx) tx.textContent = '';
        return;
      }
      if (tx) tx.textContent = '';
      setCallStatus('SARA está pensando...', 'thinking');
      await callSendToSARA(userText);
    };

    rec.onerror = e => {
      callRecog = null;
      if (micBtn) micBtn.classList.remove('listening');
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        setCallStatus('Error de micrófono: ' + e.error, 'idle');
      } else {
        setCallStatus('Toca el micrófono para hablar.', 'idle');
      }
    };

    rec.start();
  }

  async function callSendToSARA(text) {
    const sessionId = document.getElementById('sara-session-id')?.textContent || 'call-' + Date.now();
    let fullText = '';
    try {
      const res = await fetch('/api/sara/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId }),
      });
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'chunk') fullText += evt.text;
            if (evt.type === 'cerrar_chat') { closeCall(); return; }
          } catch {}
        }
      }
    } catch {
      setCallStatus('Error de conexión.', 'idle');
      return;
    }

    const clean = fullText
      .replace(/NUEVA_ORDEN\s*:\s*\{[\s\S]*?\}/gi, '')
      .replace(/LEAD_DATA\s*:\s*\{[^\n]*\}/gi, '')
      .replace(/CERRAR_CHAT|ESCALAR_HUMANO/gi, '')
      .replace(/[*_`#>]/g, '')
      .trim();

    if (!clean || !callActive) return;
    setCallStatus('SARA está respondiendo...', 'speaking');
    await callPlayTTS(clean);
    if (!callActive) return;
    setCallStatus('Toca el micrófono para hablar.', 'idle');
    if (callAutoListen) setTimeout(callListen, 600);
  }

  function callPlayTTS(text) {
    return new Promise(resolve => {
      fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 2500), agente: 'sara' }),
      }).then(r => r.ok ? r.blob() : Promise.reject('elevenlabs_error'))
        .then(blob => {
          const url = URL.createObjectURL(blob);
          callAudio = new Audio(url);
          callAudio.play();
          callAudio.onended = () => { URL.revokeObjectURL(url); callAudio = null; resolve(); };
          callAudio.onerror = () => { callAudio = null; callBrowserTTS(text, resolve); };
        })
        .catch(() => callBrowserTTS(text, resolve));
    });
  }

  function callBrowserTTS(text, resolve) {
    if (!window.speechSynthesis) { resolve(); return; }
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text.slice(0, 3000));
    utt.lang  = 'es-MX';
    utt.rate  = 1.05;
    utt.pitch = 1.1;
    const loadAndSpeak = () => {
      const voices   = window.speechSynthesis.getVoices();
      const preferred = voices.find(v => v.lang === 'es-MX' || v.lang === 'es-US' || v.lang.startsWith('es'));
      if (preferred) utt.voice = preferred;
      utt.onend   = resolve;
      utt.onerror = resolve;
      window.speechSynthesis.speak(utt);
    };
    if (window.speechSynthesis.getVoices().length > 0) loadAndSpeak();
    else window.speechSynthesis.addEventListener('voiceschanged', loadAndSpeak, { once: true });
  }

  // ── PREDICTIVE ALERTS WIDGET ──────────────────────────────────────────────
  function loadPredictiveAlerts() {
    fetch('/api/alertas/predictivas')
      .then(r => r.json())
      .then(data => renderAlerts(data.alertas || []))
      .catch(() => {});
  }

  function renderAlerts(alertas) {
    const list = document.getElementById('cmd-alert-list');
    const badge = document.getElementById('cmd-alert-count');
    if (!list) return;

    if (badge) {
      badge.textContent = alertas.length;
      badge.className = 'cmd-alert-badge ' + (alertas.length > 0 ? 'active' : '');
    }

    if (alertas.length === 0) {
      list.innerHTML = '<div class="cmd-alert-empty">Sin alertas activas</div>';
      return;
    }

    list.innerHTML = alertas.map(a => `
      <div class="cmd-alert-item ${a.nivel.toLowerCase()}">
        <div class="cmd-alert-row">
          <span class="cmd-alert-nivel ${a.nivel.toLowerCase()}">${a.nivel === 'CRITICO' ? '🔴' : '🟡'} ${a.nivel}</span>
          <span class="cmd-alert-unidad">${a.unidad}</span>
          <span class="cmd-alert-zona">${a.zona}</span>
        </div>
        <div class="cmd-alert-trigger">${a.trigger}</div>
        <div class="cmd-alert-accion">→ ${a.accion}</div>
      </div>
    `).join('');
  }

  // ── TARIFF TICKER ─────────────────────────────────────────────────────────
  function loadTariff() {
    fetch('/api/tarifa/contexto')
      .then(r => r.json())
      .then(renderTariff)
      .catch(() => {});
  }

  function renderTariff(data) {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('tariff-diesel',  `$${data.diesel}/L`);
    set('tariff-demand',  data.demand);
    set('tariff-mult',    `x${data.multiplier}`);
    set('tariff-updated', data.updated);

    const demandEl = document.getElementById('tariff-demand');
    if (demandEl) {
      demandEl.className = 'tariff-val ' +
        (data.demand === 'MUY ALTA' ? 'text-rojo' : data.demand === 'ALTA' ? 'text-amber' : 'text-verde');
    }

    const rutas = document.getElementById('tariff-rutas');
    if (rutas && data.rutas) {
      rutas.innerHTML = Object.entries(data.rutas).map(([ruta, precio]) => `
        <div class="tariff-ruta">
          <span class="tariff-ruta-label">${ruta}</span>
          <span class="tariff-ruta-val">$${precio.toLocaleString('es-MX')}</span>
        </div>
      `).join('');
    }
  }

  // ── INIT ──────────────────────────────────────────────────────────────────
  function init() {
    watchBubbles();
    initMic('sofia-input', 'sofia-mic');
    initCallMode(); // sara-mic maneja call mode, no STT directo
    loadPredictiveAlerts();
    loadTariff();

    // Refrescar alertas cada 5 min, tarifas cada 10 min
    setInterval(loadPredictiveAlerts, 300000);
    setInterval(loadTariff, 600000);

    // Refrescar tarifas cuando se abre el portal
    document.getElementById('btn-open-portal')?.addEventListener('click', () => {
      setTimeout(loadTariff, 100);
    });
    document.getElementById('btn-open-portal-2')?.addEventListener('click', () => {
      setTimeout(loadTariff, 100);
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  return { playTTS, speakResponse, loadPredictiveAlerts, loadTariff, openCall, closeCall };
})();
