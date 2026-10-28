// server.js: run with `npm start`.
// Env: PORT, GRACE_MIN (minutes before "missed", use 2 for demos), TICK_SECONDS, DATA_FILE, DEVICE_KEY,
//      TWILIO_SID / TWILIO_TOKEN / TWILIO_FROM (optional SMS), ALERT_WEBHOOK_URL (optional)
process.env.TZ = process.env.TZ || "Asia/Kolkata";

const { createApp } = require("./app");

const { app, tick, store } = createApp({
  dataFile: process.env.DATA_FILE || "./data.json",
  deviceKey: process.env.DEVICE_KEY,
});

const tickMs = Number(process.env.TICK_SECONDS || 15) * 1000;
setInterval(tick, tickMs);
tick();

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`medtrack backend on :${port} | tick every ${tickMs / 1000}s | missed after ${process.env.GRACE_MIN || 30} min`);
});

process.on("SIGINT", () => {
  store.flush();
  process.exit(0);
});
