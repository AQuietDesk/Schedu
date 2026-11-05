// Frees the Vite dev server port (1420, see vite.config.ts's strictPort: true)
// before it starts. Runs automatically as the "predev" npm lifecycle hook, so
// it also fires when tauri.conf.json's beforeDevCommand ("npm run dev") is
// invoked by `tauri dev`.
//
// Why this exists: strictPort means Vite refuses to fall back to another port
// if 1420 is already taken — it just exits. If a previous dev session's Vite
// process didn't fully exit (e.g. the terminal or IDE was closed instead of
// Ctrl+C'd), that orphan keeps holding the port, so the *next* `tauri dev`
// starts a Vite that immediately fails while the Tauri window still opens and
// tries to load http://localhost:1420 — producing "localhost refused to
// connect / ERR_CONNECTION_REFUSED" in the app window. See
// docs/TROUBLESHOOTING.md for the full explanation and manual recovery steps.
import { execSync } from "node:child_process";

const port = process.argv[2] || "1420";

function killWindows(port) {
  let output;
  try {
    output = execSync("netstat -ano -p TCP", { encoding: "utf8" });
  } catch {
    return;
  }
  const pids = new Set();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (match && match[1] === String(port)) pids.add(match[2]);
  }
  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
      console.log(`[free-dev-port] freed port ${port} (killed stale PID ${pid})`);
    } catch {
      // already gone
    }
  }
}

function killPosix(port) {
  let pids;
  try {
    pids = execSync(`lsof -ti tcp:${port}`, { encoding: "utf8" }).trim();
  } catch {
    return;
  }
  if (!pids) return;
  for (const pid of pids.split("\n")) {
    try {
      execSync(`kill -9 ${pid}`, { stdio: "ignore" });
      console.log(`[free-dev-port] freed port ${port} (killed stale PID ${pid})`);
    } catch {
      // already gone
    }
  }
}

if (process.platform === "win32") {
  killWindows(port);
} else {
  killPosix(port);
}
