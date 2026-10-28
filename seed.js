// seed.js: sets up the demo (elder, family member, paired box, one medicine due in 2 minutes).
// Usage: start the server (GRACE_MIN=2 npm start), then `node seed.js`.
// Optional env: BASE (default http://localhost:3000), FAMILY_PHONE (for SMS if Twilio is configured).
const BASE = process.env.BASE || "http://localhost:3000";

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

(async () => {
  const elder = await call("POST", "/users", { name: "Dadi", role: "elder" });
  const family = await call("POST", "/users", {
    name: "Ravi",
    role: "family",
    phone: process.env.FAMILY_PHONE,
    linkedElderId: elder.id,
  });
  await call("POST", "/devices", { deviceId: "box-1", elderId: elder.id });

  // pretend the app scanned a strip: raw OCR text -> parsed expiry
  const parsed = await call("POST", "/expiry/parse", { text: "B.No A1234 MFG 08/25 EXP 08/27" });
  const med = await call("POST", "/medicines", { elderId: elder.id, name: "BP tablet", expiryDate: parsed.expiryDate });
  const sched = await call("POST", "/schedules", { medicineId: med.id, inMinutes: 2 });

  console.log(`Seeded. ${med.name} expires ${med.expiryDate} (${med.status}); first dose at ${sched.time}.\n`);
  console.log("Demo:");
  console.log("  1) Wait for the dose time + GRACE_MIN without opening the box -> family gets a 'missed' alert:");
  console.log(`     curl ${BASE}/alerts?userId=${family.id}`);
  console.log("  2) Or simulate opening the lid (what the ESP32 sends):");
  console.log(`     curl -X POST ${BASE}/lid-event -H 'Content-Type: application/json' -d '{"deviceId":"box-1"}'`);
  console.log("  3) Dose log and adherence:");
  console.log(`     curl ${BASE}/doses?elderId=${elder.id}`);
  console.log(`     curl ${BASE}/adherence?elderId=${elder.id}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
