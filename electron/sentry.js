const path = require("path");
const fs = require("fs");

let Sentry = null;
let initialized = false;

function getDsn() {
  if (process.env.REACT_APP_SENTRY_DSN) return process.env.REACT_APP_SENTRY_DSN;
  try {
    const envPath = path.join(__dirname, "../.env");
    const content = fs.readFileSync(envPath, "utf8");
    const m = content.match(/^REACT_APP_SENTRY_DSN=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return null;
}

function init(isDev) {
  const dsn = getDsn();
  if (!dsn || initialized || isDev) return;

  try {
    Sentry = require("@sentry/electron/main");
    Sentry.init({
      dsn,
      environment: "production",
      sampleRate: 1.0,
      beforeSend(event) {
        // Filter recurring OS command noise that isn't actionable
        const msg = event.exception?.values?.[0]?.value || "";
        if (/lsof|spawn\s|ENOENT|EPERM|EACCES/.test(msg)) return null;
        return event;
      },
    });
    initialized = true;
  } catch (err) {
    console.error("Sentry init failed:", err.message);
  }
}

function captureException(err) {
  if (!initialized || !Sentry) return;
  Sentry.captureException(err);
}

async function flush() {
  if (!initialized || !Sentry) return;
  try {
    await Sentry.flush(2000);
  } catch {}
}

module.exports = { init, captureException, flush };
