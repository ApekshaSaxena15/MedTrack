// app.js: API + dose scheduler. createApp() takes an injectable clock so tests can fast-forward time.
const http = require("http");
const { parseExpiry, expiryStatus } = require("./expiryParser");
const { createStore } = require("./store");
const { createNotifier } = require("./notifier");

const MIN = 60000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const pad = (n) => String(n).padStart(2, "0");
const dateKey = (t) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;

// Minimal router on node:http (zero dependencies, so there is nothing to npm install).
// Handlers get Express-like (req, res): req.body / req.query / req.params / req.get(), res.status().json().
function createMiniApp() {
  const routes = [];
  const add = (method) => (path, handler) => {
    const keys = [];
    const re = new RegExp("^" + path.replace(/:([A-Za-z]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$");
    routes.push({ method, re, keys, handler });
  };

  const server = http.createServer((req, res) => {
    res.status = (code) => ((res.statusCode = code), res);
    res.json = (obj) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(obj));
      return res;
    };
    req.get = (h) => req.headers[h.toLowerCase()];

    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      req.query = Object.fromEntries(url.searchParams);
      try {
        req.body = raw ? JSON.parse(raw) : {};
      } catch {
        return res.status(400).json({ error: "invalid JSON body" });
      }
      for (const r of routes) {
        const m = r.method === req.method && r.re.exec(url.pathname);
        if (!m) continue;
        req.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        try {
          return r.handler(req, res);
        } catch (e) {
          return res.status(500).json({ error: e.message });
        }
      }
      res.status(404).json({ error: "not found" });
    });
  });

  return { get: add("GET"), post: add("POST"), listen: (...args) => server.listen(...args) };
}

function createApp(opts = {}) {
  const now = opts.now || (() => new Date());
  const graceMin = opts.graceMin ?? Number(process.env.GRACE_MIN || 30); // wait this long before "missed"
  const earlyMin = opts.earlyMin ?? 15; // lid opened this early still counts for the next dose
  const lateMin = opts.lateMin ?? 60;   // lid opened this long after "missed" counts as taken late
  const store = opts.store || createStore(opts.dataFile);
  const d = store.data;
  const notifier = opts.notifier || createNotifier({ store, log: opts.log });

  const user = (id) => d.users.find((u) => u.id === id);
  const medicine = (id) => d.medicines.find((m) => m.id === id);
  const familyOf = (elderId) => d.users.filter((u) => u.role === "family" && u.linkedElderId === elderId);

  function notifyElder(elderId, msg) {
    const u = user(elderId);
    if (u) notifier.send(u, msg, now());
  }
  function notifyFamily(elderId, msg) {
    for (const f of familyOf(elderId)) notifier.send(f, msg, now());
  }

  const dueAtFor = (s, t) => {
    const [hh, mm] = s.time.split(":").map(Number);
    return new Date(t.getFullYear(), t.getMonth(), t.getDate(), hh, mm, 0, 0);
  };
  const runsToday = (s, t) => !s.daysOfWeek?.length || s.daysOfWeek.includes(t.getDay());

  function createDose(s, due, t, extra = {}) {
    const e = {
      id: store.id("dose"),
      scheduleId: s.id,
      medicineId: s.medicineId,
      elderId: s.elderId,
      dueAt: due.toISOString(),
      dateKey: dateKey(t),
      status: "pending",
      takenAt: null,
      source: null,
      ...extra,
    };
    d.doseEvents.push(e);
    return e;
  }
  const doseExists = (s, t) => d.doseEvents.some((e) => e.scheduleId === s.id && e.dateKey === dateKey(t));

  // ---------------- scheduler ----------------
  function tick() {
    const t = now();

    // 1) create a pending dose when a schedule's time arrives, and remind the elder
    for (const s of d.schedules) {
      if (s.active === false || !runsToday(s, t)) continue;
      const due = dueAtFor(s, t);
      if (t < due || doseExists(s, t)) continue;
      if (new Date(s.createdAt) > due) continue; // schedule was created after today's time; start tomorrow
      const e = createDose(s, due, t);
      const m = medicine(s.medicineId);
      const status = m?.expiryDate ? expiryStatus(m.expiryDate, t).status : "OK";
      const warn = status === "EXPIRED" ? " WARNING: this medicine is expired, check before taking." : "";
      notifyElder(s.elderId, { kind: "reminder", title: "Time for your medicine", body: `${m?.name || "Medicine"} (${s.time}).${warn}` });
      e.reminderSent = true;
    }

    // 2) pending doses past the grace period become "missed" and the family is alerted
    for (const e of d.doseEvents) {
      if (e.status !== "pending") continue;
      if (t - new Date(e.dueAt) < graceMin * MIN) continue;
      e.status = "missed";
      e.missedAt = t.toISOString();
      const m = medicine(e.medicineId);
      const elder = user(e.elderId);
      const due = new Date(e.dueAt);
      notifyFamily(e.elderId, {
        kind: "missed",
        title: `${elder?.name || "Your family member"} missed a dose`,
        body: `${m?.name || "Medicine"} was due at ${pad(due.getHours())}:${pad(due.getMinutes())}. No lid-open or "taken" tap in ${graceMin} min.`,
      });
    }

    // 3) expiry sweep: alert the family once per status change (EXPIRING_SOON, then EXPIRED)
    for (const m of d.medicines) {
      if (!m.expiryDate) continue;
      const { status, days } = expiryStatus(m.expiryDate, t);
      if (status === "OK" || m.lastExpiryAlert === status) continue;
      m.lastExpiryAlert = status;
      const elder = user(m.elderId);
      notifyFamily(m.elderId, {
        kind: status === "EXPIRED" ? "expired" : "expiring",
        title: status === "EXPIRED" ? `${m.name} has expired` : `${m.name} expires soon`,
        body:
          status === "EXPIRED"
            ? `${elder?.name || "They"} may still have it at home. Replace it and dispose of the old one safely.`
            : `Expires in ${days} day(s) (${m.expiryDate}). Plan a refill.`,
      });
    }
    store.save();
  }

  // ---------------- dose resolution (lid or manual tap) ----------------
  function resolveDose(e, source, t, status = "taken") {
    e.status = status;
    e.source = source;
    e.takenAt = t.toISOString();
    return e;
  }

  function handleLidOpen(elderId, t) {
    const mine = d.doseEvents.filter((e) => e.elderId === elderId);

    // a) oldest pending dose (due time has arrived)
    const pending = mine.filter((e) => e.status === "pending").sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))[0];
    if (pending) return resolveDose(pending, "lid", t);

    // b) recently missed -> taken late, and tell the family it's resolved.
    //    Checked before "early" so an overdue dose wins over pre-taking a future one.
    const late = mine
      .filter((e) => e.status === "missed" && t - new Date(e.missedAt) <= lateMin * MIN)
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))[0]; // oldest overdue first
    if (late) {
      resolveDose(late, "lid", t, "taken_late");
      const m = medicine(late.medicineId);
      notifyFamily(elderId, { kind: "late", title: "Dose taken late", body: `${m?.name || "Medicine"} was taken after the reminder window.` });
      return late;
    }

    // c) a schedule due within the next earlyMin minutes -> counts as an early dose
    for (const s of d.schedules.filter((s) => s.elderId === elderId && s.active !== false && runsToday(s, t))) {
      const due = dueAtFor(s, t);
      if (due > t && due - t <= earlyMin * MIN && !doseExists(s, t)) {
        return resolveDose(createDose(s, due, t), "lid", t, "taken");
      }
    }
    return null; // lid opened but nothing was due
  }

  // ---------------- HTTP API ----------------
  const app = createMiniApp();

  const need = (res, cond, msg) => (cond ? false : (res.status(400).json({ error: msg }), true));

  app.get("/", (req, res) => res.json({ ok: true, service: "medtrack-backend", now: now().toISOString() }));

  // users
  app.post("/users", (req, res) => {
    const { name, role, phone, fcmToken, linkedElderId } = req.body || {};
    if (need(res, name && ["elder", "family"].includes(role), "name and role ('elder'|'family') required")) return;
    if (need(res, role === "elder" || user(linkedElderId)?.role === "elder", "family users need a valid linkedElderId")) return;
    const u = { id: store.id("u"), name, role, phone, fcmToken, linkedElderId: role === "family" ? linkedElderId : undefined };
    d.users.push(u);
    store.save();
    res.status(201).json(u);
  });

  // pair a smart pill box with an elder
  app.post("/devices", (req, res) => {
    const { deviceId, elderId } = req.body || {};
    if (need(res, deviceId && user(elderId)?.role === "elder", "deviceId and valid elderId required")) return;
    d.devices = d.devices.filter((x) => x.deviceId !== deviceId);
    d.devices.push({ deviceId, elderId });
    store.save();
    res.status(201).json({ deviceId, elderId });
  });

  // OCR helper: the app sends raw ML Kit text, gets a parsed expiry to confirm
  app.post("/expiry/parse", (req, res) => {
    if (need(res, typeof req.body?.text === "string", "text required")) return;
    res.json(parseExpiry(req.body.text));
  });

  // medicines
  app.post("/medicines", (req, res) => {
    const { elderId, name, expiryDate } = req.body || {};
    if (need(res, user(elderId)?.role === "elder" && name, "valid elderId and name required")) return;
    if (need(res, !expiryDate || /^\d{4}-\d{2}-\d{2}$/.test(expiryDate), "expiryDate must be YYYY-MM-DD")) return;
    const m = { id: store.id("med"), elderId, name, expiryDate };
    d.medicines.push(m);
    store.save();
    res.status(201).json({ ...m, ...(expiryDate ? expiryStatus(expiryDate, now()) : {}) });
  });

  app.get("/medicines", (req, res) => {
    const list = d.medicines
      .filter((m) => !req.query.elderId || m.elderId === req.query.elderId)
      .map((m) => ({ ...m, ...(m.expiryDate ? expiryStatus(m.expiryDate, now()) : { status: "UNKNOWN" }) }));
    res.json(list);
  });

  // schedules: give "time" (HH:MM) or "inMinutes" (handy for demos)
  app.post("/schedules", (req, res) => {
    const { medicineId, time, inMinutes, daysOfWeek } = req.body || {};
    const m = medicine(medicineId);
    if (need(res, m, "valid medicineId required")) return;
    let hhmm = time;
    if (inMinutes !== undefined) {
      const t = new Date(now().getTime() + Number(inMinutes) * MIN);
      hhmm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
    }
    if (need(res, TIME_RE.test(hhmm || ""), "time must be HH:MM (24h) or give inMinutes")) return;
    const s = {
      id: store.id("sch"),
      medicineId,
      elderId: m.elderId,
      time: hhmm,
      daysOfWeek: Array.isArray(daysOfWeek) ? daysOfWeek : [],
      active: true,
      createdAt: now().toISOString(),
    };
    d.schedules.push(s);
    store.save();
    res.status(201).json(s);
  });

  app.get("/schedules", (req, res) =>
    res.json(d.schedules.filter((s) => !req.query.elderId || s.elderId === req.query.elderId))
  );

  // ESP32 lid sensor. Uses server time because the ESP32 has no real-time clock.
  app.post("/lid-event", (req, res) => {
    if (opts.deviceKey && req.get("x-device-key") !== opts.deviceKey) return res.status(401).json({ error: "bad device key" });
    const dev = d.devices.find((x) => x.deviceId === req.body?.deviceId);
    if (need(res, dev, "unknown deviceId, pair it with POST /devices")) return;
    const t = now();
    const dose = handleLidOpen(dev.elderId, t);
    d.lidEvents.push({ id: store.id("lid"), deviceId: dev.deviceId, elderId: dev.elderId, at: t.toISOString(), matchedDoseId: dose?.id || null });
    store.save();
    // "likely taken": a lid open can't prove a pill was swallowed
    res.json({ ok: true, matchedDoseId: dose?.id || null, status: dose?.status || "no_dose_due" });
  });

  // ESP32 polls this to drive the buzzer/LED
  app.get("/device/:deviceId/status", (req, res) => {
    const dev = d.devices.find((x) => x.deviceId === req.params.deviceId);
    if (!dev) return res.status(404).json({ error: "unknown deviceId" });
    const due = d.doseEvents.filter((e) => e.elderId === dev.elderId && e.status === "pending");
    res.json({ dueNow: due.length > 0, medicines: due.map((e) => medicine(e.medicineId)?.name) });
  });

  // manual "I took it" tap from the elder's big-button screen
  app.post("/dose/:id/taken", (req, res) => {
    const e = d.doseEvents.find((x) => x.id === req.params.id);
    if (!e) return res.status(404).json({ error: "dose not found" });
    if (e.status === "taken" || e.status === "taken_late") return res.json(e);
    const late = e.status === "missed";
    resolveDose(e, "app", now(), late ? "taken_late" : "taken");
    if (late) {
      notifyFamily(e.elderId, { kind: "late", title: "Dose taken late", body: `${medicine(e.medicineId)?.name || "Medicine"} was marked taken after the reminder window.` });
    }
    store.save();
    res.json(e);
  });

  app.get("/doses", (req, res) => {
    const list = d.doseEvents.filter((e) => (!req.query.elderId || e.elderId === req.query.elderId) && (!req.query.status || e.status === req.query.status));
    res.json(list.map((e) => ({ ...e, medicineName: medicine(e.medicineId)?.name })));
  });

  app.get("/alerts", (req, res) => {
    const list = d.alerts.filter((a) => !req.query.userId || a.userId === req.query.userId);
    res.json(list.slice().reverse());
  });

  // last N days (default 7) adherence for the family / doctor report
  app.get("/adherence", (req, res) => {
    const { elderId } = req.query;
    if (need(res, user(elderId), "valid elderId required")) return;
    const days = Number(req.query.days || 7);
    const since = now().getTime() - days * 24 * 60 * MIN;
    const list = d.doseEvents.filter((e) => e.elderId === elderId && new Date(e.dueAt).getTime() >= since);
    const count = (...s) => list.filter((e) => s.includes(e.status)).length;
    const onTime = count("taken");
    const late = count("taken_late");
    const missed = count("missed");
    const resolved = onTime + late + missed;
    res.json({ elderId, days, onTime, late, missed, pending: count("pending"), adherencePct: resolved ? Math.round(((onTime + late) / resolved) * 100) : null });
  });

  return { app, tick, store };
}

module.exports = { createApp };
