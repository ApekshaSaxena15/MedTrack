// app.test.js: run with `npm test`. Uses a fake clock so a whole day of doses runs in milliseconds.
process.env.TZ = "Asia/Kolkata";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("./app");

async function boot() {
  let clock = new Date(2026, 9, 28, 9, 0, 0);
  const { app, tick, store } = createApp({ now: () => new Date(clock), graceMin: 30, log: () => {} });
  const srv = app.listen(0);
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  async function api(method, path, body, raw) {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    return { status: res.status, body: await res.json() };
  }
  const at = (h, m, day = 28) => (clock = new Date(2026, 9, day, h, m, 0));
  const close = () => { srv.closeAllConnections?.(); srv.close(); };
  return { api, at, tick, store, close };
}

test("full day: reminders, missed alert, lid, early/late, expiry, adherence", async () => {
  const { api, at, tick, close } = await boot();
  try {
    const elder = (await api("POST", "/users", { name: "Dadi", role: "elder" })).body;
    const family = (await api("POST", "/users", { name: "Ravi", role: "family", phone: "+910000000000", linkedElderId: elder.id })).body;
    await api("POST", "/devices", { deviceId: "box-1", elderId: elder.id });

    const med = async (name, expiryDate) => (await api("POST", "/medicines", { elderId: elder.id, name, expiryDate })).body;
    const bp = await med("BP tablet", "2026-11-17");        // expiring soon (<30 days)
    const metformin = await med("Metformin", "2026-10-01"); // already expired
    const aspirin = await med("Aspirin", "2028-01-31");
    const vitD = await med("Vitamin D", "2028-01-31");
    const iron = await med("Iron", "2028-01-31");
    assert.equal(bp.status, "EXPIRING_SOON");
    assert.equal(metformin.status, "EXPIRED");

    const sched = async (m, time) => (await api("POST", "/schedules", { medicineId: m.id, time })).body;
    await sched(bp, "09:05");
    await sched(metformin, "10:00");
    await sched(aspirin, "12:00");
    await sched(vitD, "14:00");
    await sched(iron, "14:30");

    const familyAlerts = async () => (await api("GET", `/alerts?userId=${family.id}`)).body;
    const elderAlerts = async () => (await api("GET", `/alerts?userId=${elder.id}`)).body;

    // 09:00 nothing due yet; expiry sweep alerts family once, not on every tick
    tick();
    assert.deepEqual((await familyAlerts()).map((a) => a.kind).sort(), ["expired", "expiring"]);
    tick();
    assert.equal((await familyAlerts()).length, 2, "expiry alerts must not repeat");
    assert.equal((await api("GET", "/doses")).body.length, 0);

    // 09:05 BP dose becomes pending, elder is reminded, pill box buzzer should fire
    at(9, 5); tick(); tick();
    assert.equal((await api("GET", "/doses?status=pending")).body.length, 1, "no duplicate doses on repeated ticks");
    assert.equal((await elderAlerts())[0].kind, "reminder");
    const dev = (await api("GET", "/device/box-1/status")).body;
    assert.equal(dev.dueNow, true);
    assert.deepEqual(dev.medicines, ["BP tablet"]);

    // 09:20 still inside the 30 min grace window: no missed alert
    at(9, 20); tick();
    assert.equal((await familyAlerts()).filter((a) => a.kind === "missed").length, 0);

    // 09:36 grace over: dose missed, family alerted (the demo moment)
    at(9, 36); tick();
    const missed = (await familyAlerts()).filter((a) => a.kind === "missed");
    assert.equal(missed.length, 1);
    assert.match(missed[0].title, /Dadi missed a dose/);
    assert.match(missed[0].body, /BP tablet/);
    tick();
    assert.equal((await familyAlerts()).filter((a) => a.kind === "missed").length, 1, "missed alert must fire once");

    // 09:50 she opens the box late: taken_late, family told it resolved
    at(9, 50);
    let r = (await api("POST", "/lid-event", { deviceId: "box-1" })).body;
    assert.equal(r.status, "taken_late");
    assert.equal((await familyAlerts()).filter((a) => a.kind === "late").length, 1);

    // 10:00 Metformin is due; reminder warns it is expired; lid open at 10:02 marks it taken
    at(10, 0); tick();
    assert.match((await elderAlerts())[0].body, /expired/i);
    at(10, 2);
    r = (await api("POST", "/lid-event", { deviceId: "box-1" })).body;
    assert.equal(r.status, "taken");
    const metDose = (await api("GET", "/doses")).body.find((d) => d.medicineName === "Metformin");
    assert.equal(metDose.source, "lid");

    // 10:05 lid opens with nothing due
    at(10, 5);
    r = (await api("POST", "/lid-event", { deviceId: "box-1" })).body;
    assert.equal(r.status, "no_dose_due");
    assert.equal(r.matchedDoseId, null);

    // 11:50 Aspirin opened 10 min early counts as the 12:00 dose, and 12:00 does not re-create it
    at(11, 50);
    r = (await api("POST", "/lid-event", { deviceId: "box-1" })).body;
    assert.equal(r.status, "taken");
    at(12, 0); tick();
    assert.equal((await api("GET", "/doses")).body.filter((d) => d.medicineName === "Aspirin").length, 1);

    // 14:00 Vitamin D: manual "taken" tap from the elder screen
    at(14, 0); tick();
    const vit = (await api("GET", "/doses?status=pending")).body.find((d) => d.medicineName === "Vitamin D");
    at(14, 10);
    const tap = (await api("POST", `/dose/${vit.id}/taken`)).body;
    assert.equal(tap.status, "taken");
    assert.equal(tap.source, "app");

    // 14:30 Iron is never taken -> missed at 15:05
    at(14, 30); tick();
    at(15, 5); tick();
    assert.equal((await api("GET", "/doses?status=missed")).body.length, 1);

    // Adherence: on time = Metformin, Aspirin, Vitamin D; late = BP; missed = Iron -> 4 of 5 = 80%
    const adh = (await api("GET", `/adherence?elderId=${elder.id}`)).body;
    assert.deepEqual([adh.onTime, adh.late, adh.missed, adh.adherencePct], [3, 1, 1, 80]);

    // Next morning the schedule fires again
    at(9, 5, 29); tick();
    assert.equal((await api("GET", "/doses?status=pending")).body.filter((d) => d.medicineName === "BP tablet").length, 1);
  } finally {
    close();
  }
});

test("validation and helpers", async () => {
  const { api, at, tick, close } = await boot();
  try {
    assert.equal((await api("POST", "/users", { name: "X", role: "family", linkedElderId: "nope" })).status, 400);
    assert.equal((await api("POST", "/lid-event", { deviceId: "ghost" })).status, 400);
    assert.equal((await api("POST", "/schedules", { medicineId: "nope", time: "09:00" })).status, 400);
    assert.equal((await api("POST", "/users", null, "{bad json")).status, 400);
    assert.equal((await api("GET", "/nothing-here")).status, 404);

    const elder = (await api("POST", "/users", { name: "Nani", role: "elder" })).body;
    const m = (await api("POST", "/medicines", { elderId: elder.id, name: "Test", expiryDate: "2028-01-31" })).body;
    assert.equal((await api("POST", "/schedules", { medicineId: m.id, time: "9am" })).status, 400);

    // demo shortcut: inMinutes
    const s = (await api("POST", "/schedules", { medicineId: m.id, inMinutes: 2 })).body;
    assert.equal(s.time, "09:02");
    at(9, 2); tick();
    assert.equal((await api("GET", "/doses?status=pending")).body.length, 1);

    // schedule created after today's time does not instantly create a "missed" dose
    at(11, 0);
    await api("POST", "/schedules", { medicineId: m.id, time: "08:00" });
    tick();
    assert.equal((await api("GET", "/doses")).body.filter((d) => d.dueAt.includes("02:30")).length, 0); // 08:00 IST = 02:30Z

    // OCR helper endpoint
    const p = (await api("POST", "/expiry/parse", { text: "MFG 08/25 EXP 08/27" })).body;
    assert.equal(p.expiryDate, "2027-08-31");
  } finally {
    close();
  }
});
