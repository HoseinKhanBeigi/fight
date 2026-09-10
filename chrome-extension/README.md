# Fight Aggression Alerts (Chrome)

Shows Chrome desktop notifications when the fight server fires `aggressionAlert` (30s / $500K spikes).

## Install

1. Run the app: `pnpm run ui` (http://localhost:8787)
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode**
4. **Load unpacked** → select this `chrome-extension` folder
5. Allow notifications if Chrome asks

## Settings

Click the extension icon:
- **WebSocket URL** — local default `ws://127.0.0.1:8787/ws`
- For Railway use `wss://YOUR-APP.up.railway.app/ws`
- Click a notification to open the UI

Works even when the fight tab is closed (as long as the server is running).
