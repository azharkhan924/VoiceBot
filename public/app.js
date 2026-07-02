// public/app.js
// Client-side controller for WebRTC Live Calling, Audio Stream processing,
// Visualizers, and Telephony logs management.

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const btnStartCall = document.getElementById('btn-start-call');
  const btnEndCall = document.getElementById('btn-end-call');
  const btnPttSpeak = document.getElementById('btn-ptt-speak');
  const btnModeVad = document.getElementById('btn-mode-vad');
  const btnModePtt = document.getElementById('btn-mode-ptt');
  const callerIdInput = document.getElementById('caller-id-input');
  const callStatusTag = document.getElementById('call-status-tag');
  const liveTranscript = document.getElementById('live-transcript');
  const visualizerLabel = document.getElementById('visualizer-label');
  const canvas = document.getElementById('audio-visualizer');
  const canvasCtx = canvas.getContext('2d');
  const logsTbody = document.getElementById('logs-tbody');
  const btnRefreshLogs = document.getElementById('btn-refresh-logs');
  const btnCopyWebhook = document.getElementById('btn-copy-webhook');
  const webhookUrlInput = document.getElementById('webhook-url');
  const modalTranscript = document.getElementById('modal-transcript');
  const btnCloseModal = document.getElementById('btn-close-modal');
  const modalBody = document.getElementById('modal-transcript-body');

  // Set default webhook URL based on current origin
  webhookUrlInput.value = `${window.location.origin}/twilio/voice`;

  // State
  let ws = null;
  let audioContext = null;
  let mediaStream = null;
  let processorNode = null;
  let analyserNode = null;
  let callId = null;
  let callingMode = 'vad'; // 'vad' or 'ptt'
  let isCallActive = false;
  let isSpeaking = false;
  let isPttPressed = false;
  let isBotSpeaking = false;
  let silenceTimer = null;
  let animationFrameId = null;

  // ---- Mode Selector ----
  btnModeVad.addEventListener('click', () => {
    callingMode = 'vad';
    btnModeVad.classList.add('active');
    btnModePtt.classList.remove('active');
    if (isCallActive) {
      btnPttSpeak.classList.add('hidden');
    }
  });

  btnModePtt.addEventListener('click', () => {
    callingMode = 'ptt';
    btnModePtt.classList.add('active');
    btnModeVad.classList.remove('active');
    if (isCallActive) {
      btnPttSpeak.classList.remove('hidden');
    }
  });

  // ---- Start Call ----
  btnStartCall.addEventListener('click', async () => {
    try {
      callStatusTag.textContent = 'Connecting...';
      callStatusTag.style.color = '#f59e0b';

      // 1. Open audio microphone
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(mediaStream);
      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 256;
      source.connect(analyserNode);

      // Setup ScriptProcessor for PCM capture (buffer size 4096 = ~256ms at 16kHz)
      processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      analyserNode.connect(processorNode);
      processorNode.connect(audioContext.destination);

      // 2. Open WebSocket
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/media-stream`;
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        isCallActive = true;
        callId = `web-${Date.now()}`;
        const callerId = callerIdInput.value.trim() || '+91-WebCaller';

        ws.send(JSON.stringify({ type: 'start_call', callId, callerId }));

        // UI updates
        btnStartCall.classList.add('hidden');
        btnEndCall.classList.remove('hidden');
        if (callingMode === 'ptt') btnPttSpeak.classList.remove('hidden');
        callStatusTag.textContent = '🟢 Call Connected';
        callStatusTag.style.color = '#10b981';
        liveTranscript.innerHTML = '';
        appendInfoMessage('Live voice call connected. Listen for bot greeting...');
        startVisualizer();
        fetchLogs();
      };

      ws.onmessage = async (e) => {
        if (e.data instanceof ArrayBuffer) {
          // Binary audio from bot (WAV buffer)
          isBotSpeaking = true;
          visualizerLabel.textContent = '🔊 Bot Speaking...';
          visualizerLabel.style.color = '#818cf8';
          try {
            const audioBuffer = await audioContext.decodeAudioData(e.data.slice(0));
            const sourceNode = audioContext.createBufferSource();
            sourceNode.buffer = audioBuffer;
            sourceNode.connect(audioContext.destination);
            sourceNode.connect(analyserNode);
            sourceNode.start();
            sourceNode.onended = () => {
              isBotSpeaking = false;
              visualizerLabel.textContent = 'Listening...';
              visualizerLabel.style.color = '#94a3b8';
            };
          } catch (err) {
            console.error('Error playing bot audio:', err);
            isBotSpeaking = false;
          }
          return;
        }

        // JSON text frame
        const data = JSON.parse(e.data);
        if (data.type === 'reply' || data.type === 'greeting') {
          appendTurn('assistant', data.text);
        } else if (data.type === 'transcript') {
          appendTurn('user', data.text);
        } else if (data.type === 'call_ended') {
          endCallUI();
        }
      };

      ws.onclose = () => endCallUI();

      // Audio stream processing
      processorNode.onaudioprocess = (e) => {
        if (!isCallActive || isBotSpeaking) return;

        const inputData = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(inputData.length);
        let sumSquares = 0;

        for (let i = 0; i < inputData.length; i++) {
          let s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          sumSquares += pcm16[i] * pcm16[i];
        }

        const rms = Math.sqrt(sumSquares / inputData.length);

        if (callingMode === 'ptt') {
          if (isPttPressed && ws.readyState === WebSocket.OPEN) {
            ws.send(pcm16.buffer);
          }
        } else if (callingMode === 'vad') {
          // Auto VAD mode: continuously stream audio to server VAD
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(pcm16.buffer);
          }
          if (rms > 0.004) {
            // Speech detected
            isSpeaking = true;
            visualizerLabel.textContent = '🎙️ You are speaking...';
            visualizerLabel.style.color = '#10b981';
            if (silenceTimer) {
              clearTimeout(silenceTimer);
              silenceTimer = null;
            }
          } else if (isSpeaking) {
            if (!silenceTimer) {
              silenceTimer = setTimeout(() => {
                isSpeaking = false;
                visualizerLabel.textContent = '⏳ Processing...';
                visualizerLabel.style.color = '#f59e0b';
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'utterance_end' }));
                }
              }, 800);
            }
          }
        }
      };
    } catch (err) {
      console.error('Failed to start call:', err);
      callStatusTag.textContent = 'Mic Error / Denied';
      callStatusTag.style.color = '#f43f5e';
      alert('Could not access microphone: ' + err.message);
    }
  });

  // ---- End Call ----
  btnEndCall.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'end_call' }));
      ws.close();
    }
    endCallUI();
  });

  function endCallUI() {
    isCallActive = false;
    isSpeaking = false;
    isPttPressed = false;
    if (silenceTimer) clearTimeout(silenceTimer);
    if (processorNode) processorNode.disconnect();
    if (analyserNode) analyserNode.disconnect();
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    if (audioContext) audioContext.close();
    if (animationFrameId) cancelAnimationFrame(animationFrameId);

    btnStartCall.classList.remove('hidden');
    btnEndCall.classList.add('hidden');
    btnPttSpeak.classList.add('hidden');
    callStatusTag.textContent = 'Call Ended';
    callStatusTag.style.color = '#94a3b8';
    visualizerLabel.textContent = 'Mic Inactive';
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
    appendInfoMessage('Call disconnected.');
    setTimeout(fetchLogs, 1000);
  }

  // ---- Push to Talk Button ----
  btnPttSpeak.addEventListener('mousedown', () => {
    isPttPressed = true;
    visualizerLabel.textContent = '🎙️ PTT Active (Speaking)...';
    visualizerLabel.style.color = '#f59e0b';
  });

  btnPttSpeak.addEventListener('mouseup', () => {
    isPttPressed = false;
    visualizerLabel.textContent = '⏳ Processing...';
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'utterance_end' }));
    }
  });

  // ---- Transcript UI Helpers ----
  function appendTurn(role, text) {
    const div = document.createElement('div');
    div.className = `turn ${role}`;
    div.textContent = (role === 'user' ? '🧑 ' : '🤖 ') + text;
    liveTranscript.appendChild(div);
    liveTranscript.scrollTop = liveTranscript.scrollHeight;
  }

  function appendInfoMessage(msg) {
    const div = document.createElement('div');
    div.className = 'turn info-turn';
    div.textContent = msg;
    liveTranscript.appendChild(div);
    liveTranscript.scrollTop = liveTranscript.scrollHeight;
  }

  // ---- Audio Visualizer Loop ----
  function startVisualizer() {
    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function draw() {
      animationFrameId = requestAnimationFrame(draw);
      analyserNode.getByteTimeDomainData(dataArray);

      canvasCtx.fillStyle = 'rgba(10, 12, 20, 0.2)';
      canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

      canvasCtx.lineWidth = 2.5;
      canvasCtx.strokeStyle = isBotSpeaking ? '#818cf8' : '#10b981';
      canvasCtx.beginPath();

      const sliceWidth = (canvas.width * 1.0) / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;
        if (i === 0) canvasCtx.moveTo(x, y);
        else canvasCtx.lineTo(x, y);
        x += sliceWidth;
      }
      canvasCtx.lineTo(canvas.width, canvas.height / 2);
      canvasCtx.stroke();
    }
    draw();
  }

  // ---- Call History Logs Table ----
  async function fetchLogs() {
    try {
      const res = await fetch('/api/calls');
      const data = await res.json();
      if (data.status === 'ok' && data.calls) {
        renderLogs(data.calls);
      }
    } catch (err) {
      console.error('Failed to fetch call logs:', err);
    }
  }

  function renderLogs(calls) {
    if (!calls || calls.length === 0) {
      logsTbody.innerHTML = '<tr><td colspan="5" class="empty-state">No calls recorded yet.</td></tr>';
      return;
    }

    logsTbody.innerHTML = calls
      .map((c) => {
        const dateStr = new Date(c.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `
        <tr>
          <td><code style="font-size:0.75rem">${c.id.slice(0, 12)}...</code></td>
          <td><strong>${c.caller_name || c.caller_id || 'Unknown'}</strong></td>
          <td>${dateStr}</td>
          <td><span class="status-badge-sm status-${c.status}">${c.status}</span></td>
          <td><button class="btn-view" onclick="viewTranscript('${c.id}')">View</button></td>
        </tr>
      `;
      })
      .join('');
  }

  window.viewTranscript = async (callId) => {
    try {
      const res = await fetch(`/api/calls/${callId}/transcript`);
      const data = await res.json();
      modalBody.innerHTML = '';
      if (!data.transcript || data.transcript.length === 0) {
        modalBody.innerHTML = '<p style="color:#94a3b8">No dialogue recorded for this call.</p>';
      } else {
        data.transcript.forEach((t) => {
          const div = document.createElement('div');
          div.className = `turn ${t.role}`;
          div.textContent = (t.role === 'user' ? '🧑 ' : '🤖 ') + t.content;
          modalBody.appendChild(div);
        });
      }
      modalTranscript.classList.add('open');
    } catch (err) {
      alert('Failed to load transcript.');
    }
  };

  btnCloseModal.addEventListener('click', () => {
    modalTranscript.classList.remove('open');
  });

  modalTranscript.addEventListener('click', (e) => {
    if (e.target === modalTranscript) modalTranscript.classList.remove('open');
  });

  btnRefreshLogs.addEventListener('click', fetchLogs);

  btnCopyWebhook.addEventListener('click', () => {
    navigator.clipboard.writeText(webhookUrlInput.value);
    btnCopyWebhook.textContent = '✅ Copied!';
    setTimeout(() => (btnCopyWebhook.textContent = '📋 Copy'), 2000);
  });

  // Initial fetch
  fetchLogs();
});
