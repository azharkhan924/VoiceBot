# AI Incoming Voice Bot (Free Stack Only)

A lightweight AI voice bot for **incoming calls** that listens in Hindi/Hinglish,
understands the caller, and replies naturally in Hindi — built entirely on
free and open-source tools.

- **AI Reasoning:** Google Gemini 2.5 Flash (free tier) or Groq Llama models (free tier) — switchable via env var
- **Speech-to-Text:** whisper.cpp or faster-whisper (both free, offline, open-source)
- **Text-to-Speech:** Piper TTS (offline, free, natural Hindi voices) or Coqui TTS
- **Database:** SQLite (calls, transcripts, config)
- **Backend:** Node.js + Express + WebSocket

---

## 1. Architecture

```
Incoming Call (SIP/PBX bridge)
        │  raw audio (PCM16)
        ▼
 WebSocket /media-stream  ──►  backend/websocket.js (call orchestrator)
        │                              │
        │                              ├─► backend/whisper.js   (STT)
        │                              ├─► backend/ai.js        (Gemini/Groq)
        │                              ├─► backend/tts.js       (Piper/Coqui)
        │                              ├─► backend/memory.js    (in-call history)
        │                              └─► database/sqlite.js   (persistence)
        ▼
   Bot audio reply (PCM16/WAV) streamed back to caller
```

The system prompt lives in `config/prompt.txt` and is **hot-reloaded** — edit
the file and the bot's behavior changes on the very next reply, no restart
needed (via `chokidar` file watcher in `backend/prompt.js`).

---

## 2. Project Structure

```
voice-bot/
├── backend/
│   ├── server.js        # Express + WebSocket server bootstrap
│   ├── websocket.js      # Call flow orchestration (the "brain" of the pipeline)
│   ├── ai.js              # Gemini / Groq provider abstraction
│   ├── whisper.js         # STT wrapper (whisper.cpp / faster-whisper)
│   ├── tts.js             # TTS wrapper (Piper / Coqui)
│   ├── prompt.js          # Loads + hot-reloads config/prompt.txt
│   ├── memory.js          # Per-call conversation memory
│   ├── logger.js          # Winston logger (console + file)
│   ├── testClient.js      # CLI tool to simulate a call locally
│   └── scripts/
│       └── faster_whisper_transcribe.py
├── config/
│   ├── prompt.txt         # <-- Edit this to change bot behavior instantly
│   └── config.js          # Loads & centralizes all env vars
├── database/
│   └── sqlite.js          # SQLite schema + helper functions
├── logs/
│   └── calls.log
├── public/                 # (optional) static test page
├── .env.example
├── package.json
└── README.md
```

---

## 3. Prerequisites

- Node.js 18+ and npm
- Python 3.9+ (only needed if you choose `faster-whisper` or Coqui TTS)
- A free API key from **either**:
  - [Google AI Studio](https://aistudio.google.com/app/apikey) (Gemini)
  - [Groq Console](https://console.groq.com/keys) (Groq)
- `ffmpeg` (recommended, for converting/testing audio files)

---

## 4. Installation

```bash
# 1. Clone / copy the project, then install Node dependencies
cd voice-bot
npm install

# 2. Copy environment template and fill in your keys
cp .env.example .env
```

### 4.1 Install whisper.cpp (recommended STT engine)

```bash
git clone https://github.com/ggerganov/whisper.cpp bin/whisper.cpp
cd bin/whisper.cpp
make

# Download a multilingual model (medium recommended for Hindi accuracy)
bash ./models/download-ggml-model.sh medium
cd ../..
```
Set in `.env`:
```
STT_ENGINE=whispercpp
WHISPER_CPP_BIN=./bin/whisper.cpp/main
WHISPER_CPP_MODEL=./bin/whisper.cpp/models/ggml-medium.bin
```

**Alternative: faster-whisper (Python)**
```bash
pip install faster-whisper
```
Set in `.env`:
```
STT_ENGINE=fasterwhisper
FASTER_WHISPER_MODEL=medium
FASTER_WHISPER_DEVICE=cpu
```

### 4.2 Install Piper TTS (recommended TTS engine)

```bash
mkdir -p bin/piper/voices
# Download the piper binary for your OS from:
# https://github.com/rhasspy/piper/releases
# Extract it into bin/piper/

# Download a Hindi voice model (e.g. hi_IN-pratham-medium) from:
# https://github.com/rhasspy/piper/blob/master/VOICES.md
# Place the .onnx and .onnx.json files into bin/piper/voices/
```
Set in `.env`:
```
TTS_ENGINE=piper
PIPER_BIN=./bin/piper/piper
PIPER_VOICE_MODEL=./bin/piper/voices/hi_IN-pratham-medium.onnx
```

**Alternative: Coqui TTS (Python)**
```bash
pip install TTS
```
Set `TTS_ENGINE=coqui` in `.env`.

### 4.3 Configure your AI provider

```
API_PROVIDER=gemini        # or "groq"
GEMINI_API_KEY=your_key_here
GROQ_API_KEY=your_key_here
```

---

## 5. Running the Bot

```bash
npm start
# or during development, with auto-restart:
npm run dev
```

You should see:
```
Voice bot server listening on port 3000
WebSocket media endpoint: ws://localhost:3000/media-stream
AI provider: gemini | STT: whispercpp | TTS: piper
```

### 5.1 Testing without real telephony

Since real incoming PSTN calls require a telephony carrier or SIP trunk
(see section 6), you can test the full AI pipeline locally with the
included simulator:

```bash
# Prepare a 16kHz mono WAV of a spoken Hindi/Hinglish question
ffmpeg -i my_question.mp3 -ar 16000 -ac 1 -sample_fmt s16 question.wav

node backend/testClient.js question.wav
```
This opens a WebSocket connection, receives the greeting, sends your audio,
and saves the bot's spoken WAV reply into the project root.

---

## 6. Telephony Integration (Connecting Real Incoming Calls)

This project includes built-in bridges for **Cloud Telephony (Twilio / Exotel)**, **Live Browser Calling (WebRTC)**, and **SIP/PBX networks**:

### 6.1 WebRTC Live Browser Phone Dashboard (Instant Local Calling)
Open `http://localhost:3000` in your web browser. You will see a stunning dark-mode **Live Web Calling Dashboard** where you can:
- Click **"Answer Live Call"** to connect your microphone and talk directly to the AI bot in real time.
- Toggle between **Auto VAD (Continuous Talk)** and **Push-to-Talk**.
- Watch real-time audio waveform visualizers and inspect full call history logs & transcripts.

### 6.2 Twilio / Cloud Telephony Media Streams (Real PSTN Numbers)
We natively support **Twilio Voice Media Streams** with automatic G.711 µ-law <-> 16kHz PCM16 audio transcoding and server-side silence detection (VAD).
1. Expose your bot to the internet using a tunnel like ngrok:
   ```bash
   ngrok http 3000
   ```
2. In your Twilio Console under Phone Numbers -> Voice & Fax -> **A Call Comes In**, set the Webhook URL to:
   ```
   https://YOUR_NGROK_DOMAIN/twilio/voice
   ```
3. Call your Twilio phone number! The bot automatically answers, transcribes your Hindi/Hinglish speech when you pause speaking, and talks back in real time.

### 6.3 Open-Source PBX (Asterisk & FreeSWITCH)
1. **Asterisk:** Use `res_pjsip` and ARI external media to stream PCM16 audio to `ws://localhost:3000/media-stream`.
2. **FreeSWITCH:** Use `mod_audio_fork` to stream audio frames to `ws://localhost:3000/media-stream`.

---

## 7. Conversation Flow

```
Incoming Call
  → Answer Call
  → Play Greeting ("नमस्कार! मैं आपकी सहायता के लिए उपलब्ध हूँ...")
  → Listen (buffer caller audio)
  → Whisper converts speech to text
  → Send to Gemini/Groq (with system prompt + conversation memory)
  → Receive AI reply
  → Convert reply to Hindi voice (Piper/Coqui)
  → Play audio to caller
  → Repeat until caller says धन्यवाद / ठीक है / अलविदा / bye
  → Save full transcript to SQLite
  → Disconnect & wipe in-memory conversation state
```

## 8. Configuring Bot Behavior

Edit `config/prompt.txt` at any time — no restart required:

```
You are a customer support executive.
Always speak politely.
Always reply in Hindi.
Keep replies short.
Never mention you are an AI.
```

## 9. Error Handling

| Situation                  | Bot response (Hindi)                                                         |
|-----------------------------|-------------------------------------------------------------------------------|
| Speech not recognized       | "क्षमा कीजिए, आपकी बात स्पष्ट सुनाई नहीं दी। कृपया दोबारा बोलिए।"              |
| AI provider unavailable     | "क्षमा कीजिए, इस समय तकनीकी समस्या है।"                                        |
| Caller wants to end the call| "धन्यवाद। आपका दिन शुभ हो।" then disconnects                                  |

## 10. Environment Variables

See `.env.example` for the complete, commented list, including
`API_PROVIDER`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `PORT`, `VOICE`,
`STT_ENGINE`, `TTS_ENGINE`, and file paths for the local model binaries.

## 11. Data Stored in SQLite

- `calls` — call id, caller id, caller name, start/end time, status
- `transcripts` — every user/assistant turn per call
- `app_config` — optional dynamic key/value settings

Query a transcript via the built-in API:
```
GET /calls/:callId/transcript
```

## 12. Notes & Limitations

- All AI/STT/TTS components used here are free and can run fully offline
  (Piper, whisper.cpp) except the LLM call itself, which uses Gemini/Groq
  free-tier APIs over HTTPS.
- Actual PSTN phone connectivity is provided by a telephony carrier / SIP
  trunk — that layer is outside the scope of "free AI stack" and must be
  supplied by an open-source PBX (Asterisk/FreeSWITCH) as described above.
- For production use, add rate limiting, authentication on the WebSocket
  endpoint, and a proper Voice Activity Detection (VAD) module (e.g.
  `webrtcvad` or Silero VAD) instead of relying solely on the bridge to
  send `utterance_end`.
