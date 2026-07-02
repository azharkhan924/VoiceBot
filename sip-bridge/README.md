# ☎️ Free SIP / VoIP App Bridge (Option 3)

This turnkey Asterisk PBX container allows you to dial your live AI Voice Bot for **$0.00** using standard mobile VoIP apps like **Linphone** or **Zoiper**.

## 🚀 Step 1: Start the SIP Bridge
Make sure Docker is running, then launch the PBX container:
```bash
cd sip-bridge
docker compose up -d --build
```

## 📱 Step 2: Configure your Mobile App (Linphone / Zoiper)
Download **Linphone** (iOS / Android / Mac / Windows) and add a new SIP Account:
- **Username / Extension**: `101`
- **Password**: `secret101`
- **Domain / Server**: `your-server-ip` *(or `localhost` or your computer's local Wi-Fi IP address e.g. `192.168.1.5`)*
- **Transport**: `UDP`

## 📞 Step 3: Dial the AI Bot
Open Linphone keypad and dial:
👉 **`1000`**

Asterisk will instantly answer the call and bridge your microphone audio over WebSocket to `wss://voicebot-omrc.onrender.com/media-stream`! Talk to the bot completely free of carrier charges!
