// store.js: tiny JSON-file store. Fine for a hackathon; swap for Firestore/Postgres later.
const fs = require("fs");
const crypto = require("crypto");

function createStore(file) {
  const data = {
    users: [],      // {id, name, role: 'elder'|'family', phone, fcmToken, linkedElderId}
    medicines: [],  // {id, elderId, name, expiryDate, lastExpiryAlert}
    schedules: [],  // {id, medicineId, elderId, time 'HH:MM', daysOfWeek[], active, createdAt}
    devices: [],    // {deviceId, elderId}
    doseEvents: [], // {id, scheduleId, medicineId, elderId, dueAt, dateKey, status, takenAt, source}
    lidEvents: [],  // {id, deviceId, elderId, at, matchedDoseId}
    alerts: [],     // {id, userId, kind, title, body, at, channels}
  };

  if (file && fs.existsSync(file)) {
    Object.assign(data, JSON.parse(fs.readFileSync(file, "utf8")));
  }

  let timer = null;
  const write = () => fs.writeFileSync(file, JSON.stringify(data, null, 2));

  return {
    data,
    id: (prefix) => prefix + "_" + crypto.randomBytes(4).toString("hex"),
    save() {
      if (!file) return;
      clearTimeout(timer);
      timer = setTimeout(write, 100);
      timer.unref();
    },
    flush() {
      if (!file) return;
      clearTimeout(timer);
      write();
    },
  };
}

module.exports = { createStore };
