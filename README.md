# MedTrack backend

Expiry tracking and missed-dose alerts for elders. Zero dependencies, Node 18+.

```bash
GRACE_MIN=2 npm start     # demo mode: a dose is "missed" 2 min after it is due
node seed.js              # creates Dadi, Ravi, box-1 and a dose due in 2 minutes
npm test                  # full-day simulation with a fake clock
```

## How it works
- **Tick (every 15 s):** creates a pending dose when a schedule's time arrives and reminds the elder; marks a dose **missed** after `GRACE_MIN` minutes (default 30) and alerts linked family; alerts family once when a medicine becomes *expiring soon* (<=30 days) and once when it *expires*.
- **Lid open** (`POST /lid-event`) resolves, in this order: the oldest pending dose -> **taken**; a dose missed in the last 60 min -> **taken_late** (family is told); a dose due within 15 min -> **taken** early; otherwise `no_dose_due`.
- A lid open means *likely taken*, not proof. The elder can also tap "taken" (`POST /dose/:id/taken`).
- Uses server time (the ESP32 has no real-time clock). Timezone defaults to `Asia/Kolkata`.

## Endpoints
| Method | Path | Body / query |
|---|---|---|
| POST | `/users` | `{name, role: "elder"\|"family", phone?, fcmToken?, linkedElderId?}` |
| POST | `/devices` | `{deviceId, elderId}` pairs a pill box |
| POST | `/expiry/parse` | `{text}` raw OCR text -> `{found, expiryDate, needsConfirm}` |
| POST | `/medicines` | `{elderId, name, expiryDate: "YYYY-MM-DD"}` |
| GET | `/medicines?elderId=` | list with `status` (OK / EXPIRING_SOON / EXPIRED) |
| POST | `/schedules` | `{medicineId, time: "HH:MM"` or `inMinutes: 2, daysOfWeek?: [0-6]}` |
| POST | `/lid-event` | `{deviceId}` from the ESP32 (header `x-device-key` if `DEVICE_KEY` is set) |
| GET | `/device/:deviceId/status` | `{dueNow, medicines[]}` ESP32 polls this to drive the buzzer |
| POST | `/dose/:id/taken` | manual tap |
| GET | `/doses?elderId=&status=` | dose log |
| GET | `/alerts?userId=` | alerts newest first (family dashboard polls this) |
| GET | `/adherence?elderId=&days=7` | `{onTime, late, missed, pending, adherencePct}` |

## Notifications
Every alert is stored and logged. Set these to also send SMS via Twilio: `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` (the family user needs a `phone`). `ALERT_WEBHOOK_URL` posts each alert as JSON. FCM push: add it in `notifier.js` `send()` using each user's `fcmToken` (needs a Firebase service account).

## ESP32 (Arduino) sketch core
```cpp
#include <WiFi.h>
#include <HTTPClient.h>
const char* BASE = "http://YOUR_SERVER_IP:3000";
const int REED = 4, BUZZER = 5;
bool lastOpen = false;

void post(const char* path, const char* json) {
  HTTPClient http; http.begin(String(BASE) + path);
  http.addHeader("Content-Type", "application/json");
  http.POST(json); http.end();
}

void loop() {
  bool open = digitalRead(REED) == HIGH;           // magnet away from reed switch = lid open
  if (open && !lastOpen) post("/lid-event", "{\"deviceId\":\"box-1\"}");
  lastOpen = open;

  static unsigned long lastPoll = 0;
  if (millis() - lastPoll > 10000) {               // poll every 10 s
    lastPoll = millis();
    HTTPClient http; http.begin(String(BASE) + "/device/box-1/status");
    if (http.GET() == 200) digitalWrite(BUZZER, http.getString().indexOf("\"dueNow\":true") >= 0);
    http.end();
  }
  delay(50);
}
// setup(): pinMode(REED, INPUT_PULLUP); pinMode(BUZZER, OUTPUT); WiFi.begin(SSID, PASS); wait for connect.
```

## Before a real deployment
No auth on the API, JSON-file storage, and health data: add login, HTTPS, a real database, and DPDP-compliant consent first.
