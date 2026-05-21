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
    initMic('sara-input', 'sara-mic');
    initMic('sofia-input', 'sofia-mic');
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

  return { playTTS, speakResponse, loadPredictiveAlerts, loadTariff };
})();
