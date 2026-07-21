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

  // ── CALL MODE — Hands-free VAD + barge-in ────────────────────────────────
  // No push-to-talk. Always-on listening via AudioContext AnalyserNode.
  // If user speaks while AI talks → barge-in: AI stops instantly.

  let callActive      = false;
  let callSeconds     = 0;
  let callTimer       = null;
  let callAgente      = 'sara';
  let callState       = 'idle';   // idle | listening | recording | processing | speaking
  let callMuted       = false;

  // Web Audio / VAD
  let callAudioCtx    = null;
  let callAnalyser    = null;
  let callMicStream   = null;
  let callMediaRec    = null;
  let callAudioChunks = [];
  let callActiveSrc   = null;   // BufferSource — stopped on barge-in
  let callVadRafId    = null;
  let callVadActive   = false;
  let callSilTimer    = null;

  const CALL_VAD_THR  = 0.018;  // RMS amplitude threshold
  const CALL_SIL_MS   = 900;    // silence before sending clip
  const CALL_MIN_BYTES= 2000;   // ignore noise clips

  const CALL_IDENTITIES = {
    sara:  { name: 'SARA Garza',   sub: 'Ejecutiva Comercial · ABSTORAGES',         photo: '/img/sara-avatar.png'  },
    sofia: { name: 'SOFIA Novak',  sub: 'Coordinadora de Operaciones · ABSTORAGES', photo: '/img/sofia-avatar.png' },
    noa:   { name: 'NOA',          sub: 'AI Monitoreo · ABSTORAGES',                photo: '/img/noa-avatar.png'   },
    hector:{ name: 'HÉCTOR',       sub: 'AI Cobranza · ABSTORAGES',                 photo: '/img/hector-avatar.png'},
  };

  function setCallStatus(text, state) {
    const overlay = document.getElementById('call-overlay');
    const status  = document.getElementById('call-status');
    if (overlay) overlay.dataset.state = state || 'idle';
    if (status)  status.textContent = text;
  }

  function callStopAudio() {
    if (callActiveSrc) {
      try { callActiveSrc.stop(); } catch {}
      callActiveSrc = null;
    }
    window.speechSynthesis?.cancel();
  }

  function callVadLoop() {
    if (!callActive || !callAnalyser) return;

    const data = new Float32Array(callAnalyser.fftSize);
    callAnalyser.getFloatTimeDomainData(data);
    const rms = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length);
    const isSpeaking = rms > CALL_VAD_THR && !callMuted;

    if (isSpeaking) {
      // Barge-in: cut AI mid-sentence instantly
      if (callState === 'speaking') {
        callStopAudio();
        callState = 'listening';
        setCallStatus('Escuchando…', 'listening');
      }

      // Start recording when user begins speaking
      if (callState === 'listening' && !callVadActive) {
        callVadActive   = true;
        callState       = 'recording';
        callAudioChunks = [];
        try {
          callMediaRec = new MediaRecorder(callMicStream);
          callMediaRec.ondataavailable = e => { if (e.data.size > 0) callAudioChunks.push(e.data); };
          callMediaRec.start();
        } catch {}
      }

      if (callSilTimer) { clearTimeout(callSilTimer); callSilTimer = null; }

    } else if (callVadActive && !callSilTimer) {
      // User went quiet — start silence countdown
      callSilTimer = setTimeout(() => {
        callSilTimer  = null;
        callVadActive = false;
        if (callMediaRec?.state === 'recording') {
          callMediaRec.onstop = () => {
            const blob = new Blob(callAudioChunks, { type: callMediaRec.mimeType || 'audio/webm' });
            callAudioChunks = [];
            callTranscribeAndRespond(blob);
          };
          callMediaRec.stop();
        }
      }, CALL_SIL_MS);
    }

    callVadRafId = requestAnimationFrame(callVadLoop);
  }

  async function callTranscribeAndRespond(blob) {
    if (!callActive || blob.size < CALL_MIN_BYTES) {
      callState = 'listening';
      setCallStatus('Escuchando…', 'listening');
      return;
    }

    callState = 'processing';
    setCallStatus('Procesando…', 'thinking');

    try {
      // STT via ElevenLabs Scribe (public widget endpoint — no auth needed)
      const sttRes = await fetch('/api/widget/stt', {
        method: 'POST', body: blob,
        headers: { 'Content-Type': blob.type || 'audio/webm' },
      });
      const { text } = await sttRes.json();

      if (!text?.trim() || !callActive) {
        callState = 'listening';
        setCallStatus('Escuchando…', 'listening');
        return;
      }

      // Show transcript briefly
      const tx = document.getElementById('call-transcript');
      if (tx) tx.textContent = text;

      // Get AI response (streaming)
      const sessionId = document.getElementById(`${callAgente}-session-id`)?.textContent
                     || document.getElementById('sara-session-id')?.textContent
                     || 'call-' + Date.now();
      let fullText = '';
      const id = CALL_IDENTITIES[callAgente] || CALL_IDENTITIES.sara;
      setCallStatus(`${id.name} está respondiendo…`, 'speaking');
      callState = 'speaking';

      const res = await fetch(`/api/${callAgente}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId, callMode: true }),
      });
      const reader = res.body.getReader();
      const dec    = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
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

      const clean = fullText
        .replace(/NUEVA_ORDEN\s*:\s*\{[\s\S]*?\}/gi, '')
        .replace(/LEAD_DATA\s*:\s*\{[^\n]*\}/gi, '')
        .replace(/ALERTA_CRITICA\s*:\s*\{[^\n]*\}/gi, '')
        .replace(/CERRAR_CHAT|ESCALAR_HUMANO/gi, '')
        .replace(/[*_`#>]/g, '').trim();

      if (tx) tx.textContent = '';
      if (!clean || !callActive) {
        callState = 'listening';
        setCallStatus('Escuchando…', 'listening');
        return;
      }

      // Play TTS via Web Audio (AudioContext) — enables instant barge-in
      await callPlayTTSWeb(clean);

    } catch { /* silent — VAD resumes below */ }

    if (callActive) {
      callState = 'listening';
      setCallStatus('Escuchando…', 'listening');
    }
  }

  async function callPlayTTSWeb(text) {
    if (!callActive) return;

    // Try ElevenLabs via /api/tts (auth-required, uses agent-specific voice)
    if (callAudioCtx) {
      try {
        const res = await fetch('/api/tts', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text.slice(0, 2500), agente: callAgente }),
        });
        if (!res.ok) throw new Error('http');
        const buf = await res.arrayBuffer();
        if (!callActive) return;
        if (callAudioCtx.state === 'suspended') await callAudioCtx.resume();
        const decoded = await callAudioCtx.decodeAudioData(buf);
        if (!callActive) return;
        callActiveSrc = callAudioCtx.createBufferSource();
        callActiveSrc.buffer = decoded;
        callActiveSrc.connect(callAudioCtx.destination);
        await new Promise(r => { callActiveSrc.onended = r; callActiveSrc.start(0); });
        callActiveSrc = null;
        return;
      } catch { callActiveSrc = null; }
    }

    // Fallback: browser speechSynthesis
    await new Promise(resolve => {
      if (!window.speechSynthesis) { resolve(); return; }
      window.speechSynthesis.cancel();
      const utt  = new SpeechSynthesisUtterance(text.slice(0, 3000));
      utt.lang   = 'es-MX';
      utt.rate   = 1.05;
      const loadAndSpeak = () => {
        const voices    = window.speechSynthesis.getVoices();
        const preferred = voices.find(v => v.lang === 'es-MX' || v.lang === 'es-US' || v.lang.startsWith('es'));
        if (preferred) utt.voice = preferred;
        utt.onend = resolve; utt.onerror = resolve;
        window.speechSynthesis.speak(utt);
      };
      if (window.speechSynthesis.getVoices().length > 0) loadAndSpeak();
      else window.speechSynthesis.addEventListener('voiceschanged', loadAndSpeak, { once: true });
    });
  }

  function initCallMode() {
    const overlay = document.getElementById('call-overlay');
    const muteBtn = document.getElementById('call-mic-btn');
    const endBtn  = document.getElementById('call-end-btn');
    if (!overlay || !endBtn) return;

    ['sara', 'sofia', 'noa', 'hector'].forEach(ag => {
      document.getElementById(`${ag}-mic`)?.addEventListener('click', () => openCall(ag));
    });
    endBtn.addEventListener('click', closeCall);

    // Mic button becomes mute toggle during the call
    if (muteBtn) {
      muteBtn.addEventListener('click', () => {
        if (!callActive) return;
        callMuted = !callMuted;
        muteBtn.classList.toggle('muted', callMuted);
        muteBtn.title = callMuted ? 'Activar micrófono' : 'Silenciar micrófono';
        if (callMuted && callState === 'recording') {
          // Stop recording if mic is muted mid-utterance
          if (callMediaRec?.state === 'recording') callMediaRec.stop();
          callVadActive = false;
        }
        setCallStatus(callMuted ? 'Silenciado' : 'Escuchando…', callMuted ? 'idle' : 'listening');
      });
    }
  }

  async function openCall(agente = 'sara') {
    callAgente  = agente;
    callMuted   = false;
    callSeconds = 0;

    // Set overlay identity
    const id      = CALL_IDENTITIES[agente] || CALL_IDENTITIES.sara;
    const overlay = document.getElementById('call-overlay');
    if (!overlay) return;
    const nameEl  = document.getElementById('call-name');
    const subEl   = document.getElementById('call-sub');
    const photoEl = document.querySelector('.call-avatar-photo');
    if (nameEl)  nameEl.textContent = id.name;
    if (subEl)   subEl.textContent  = id.sub;
    if (photoEl) photoEl.style.backgroundImage = `url('${id.photo}')`;
    overlay.style.display = 'flex';
    setCallStatus('Iniciando llamada…', 'idle');

    // AudioContext must be created in synchronous user-gesture handler (this click)
    try {
      callAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const silBuf = callAudioCtx.createBuffer(1, 1, 22050);
      const silSrc = callAudioCtx.createBufferSource();
      silSrc.buffer = silBuf; silSrc.connect(callAudioCtx.destination); silSrc.start(0);
    } catch {}

    // Request mic
    try {
      callMicStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      setCallStatus('⚠ Permite el micrófono para usar la llamada', 'idle');
      if (callAudioCtx) { callAudioCtx.close().catch(() => {}); callAudioCtx = null; }
      overlay.style.display = 'none';
      App.toast('Permite el acceso al micrófono en el navegador', 'amber', 5000);
      return;
    }

    // Mic → analyser (no echo — NOT connected to destination)
    const micSrc  = callAudioCtx.createMediaStreamSource(callMicStream);
    callAnalyser  = callAudioCtx.createAnalyser();
    callAnalyser.fftSize = 512;
    micSrc.connect(callAnalyser);

    callActive = true;
    callState  = 'speaking';

    const muteBtn = document.getElementById('call-mic-btn');
    if (muteBtn) { muteBtn.classList.remove('muted'); muteBtn.title = 'Silenciar micrófono'; }

    // Timer
    callTimer = setInterval(() => {
      callSeconds++;
      const m = String(Math.floor(callSeconds / 60)).padStart(1,'0');
      const s = String(callSeconds % 60).padStart(2,'0');
      const el = document.getElementById('call-timer');
      if (el) el.textContent = `${m}:${s}`;
    }, 1000);

    // Greeting
    setCallStatus(`${id.name} está respondiendo…`, 'speaking');
    const GREETINGS = {
      sara:  '¡Hola! Soy SARA Garza de ABSTORAGES. ¿Con quién tengo el gusto y de qué empresa me contactas?',
      sofia: '¡Hola! Soy SOFIA Novak de ABSTORAGES. ¿En qué te puedo ayudar?',
      noa:   '¡Hola! Soy NOA de ABSTORAGES. ¿Qué folio necesitas consultar?',
      hector:'¡Hola! Soy HÉCTOR de ABSTORAGES. ¿En qué te puedo ayudar?',
    };
    await callPlayTTSWeb(GREETINGS[agente] || GREETINGS.sara);

    if (callActive) {
      callState = 'listening';
      setCallStatus('Escuchando…', 'listening');
      callVadRafId = requestAnimationFrame(callVadLoop);
    }
  }

  function closeCall() {
    callActive    = false;
    callVadActive = false;
    callMuted     = false;
    clearInterval(callTimer);
    if (callVadRafId) { cancelAnimationFrame(callVadRafId); callVadRafId = null; }
    if (callSilTimer) { clearTimeout(callSilTimer); callSilTimer = null; }
    callStopAudio();
    if (callMediaRec?.state === 'recording') { try { callMediaRec.stop(); } catch {} }
    if (callMicStream) { callMicStream.getTracks().forEach(t => t.stop()); callMicStream = null; }
    if (callAudioCtx) { callAudioCtx.close().catch(() => {}); callAudioCtx = null; }
    callAnalyser = null;
    const overlay = document.getElementById('call-overlay');
    if (overlay) overlay.style.display = 'none';
    const tx = document.getElementById('call-transcript');
    if (tx) tx.textContent = '';
    const muteBtn = document.getElementById('call-mic-btn');
    if (muteBtn) muteBtn.classList.remove('muted');
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
    initMic('sofia-input', 'sofia-dictado'); // dictado de voz al textarea de SOFIA
    initCallMode(); // sara-mic y sofia-mic manejan call mode, no STT directo
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
