// notifier.js: every alert is stored (so the family dashboard can poll /alerts)
// and logged. If Twilio env vars are set and the user has a phone, an SMS is sent too.
// FCM push can be added in send() the same way; it needs a Firebase service account.

function createNotifier({ store, log = console.log, env = process.env, fetchImpl = globalThis.fetch }) {
  async function sendSms(user, text) {
    const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM } = env;
    const body = new URLSearchParams({ To: user.phone, From: TWILIO_FROM, Body: text });
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error(`Twilio ${res.status}`);
  }

  async function sendWebhook(payload) {
    await fetchImpl(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  function send(user, { kind, title, body }, at = new Date()) {
    const alert = {
      id: store.id("al"),
      userId: user.id,
      kind,
      title,
      body,
      at: at.toISOString(),
      channels: ["inapp"],
    };
    store.data.alerts.push(alert);
    log(`[ALERT:${kind}] -> ${user.name} (${user.role}): ${title} | ${body}`);

    // External channels are fire-and-forget so a failing provider never blocks the tick.
    if (env.TWILIO_SID && env.TWILIO_TOKEN && env.TWILIO_FROM && user.phone) {
      alert.channels.push("sms");
      sendSms(user, `${title}: ${body}`).catch((e) => log("SMS failed:", e.message));
    }
    if (env.ALERT_WEBHOOK_URL) {
      alert.channels.push("webhook");
      sendWebhook({ user: { id: user.id, name: user.name, role: user.role }, ...alert }).catch((e) =>
        log("Webhook failed:", e.message)
      );
    }
    return alert;
  }

  return { send };
}

module.exports = { createNotifier };
