import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const STATE_FILE = process.env.OPENCLAW_WAKES_FILE
  || path.join(os.homedir(), ".openclaw", "session-wakes", "wakes.json");
const TICK_MS = 10000;
const MAX_ATTEMPTS = 3;

function loadWakes() {
  try {
    const wakes = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!Array.isArray(wakes)) throw new Error("wake state must be an array");
    return wakes;
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error; // Never overwrite malformed or unreadable state with an empty queue.
  }
}
function saveWakes(wakes) {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(wakes, null, 2) + "\n");
}
function newId() {
  return "wake-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}
function resolveOpenclawEntry(api) {
  if (process.env.OPENCLAW_DIST_INDEX) return process.env.OPENCLAW_DIST_INDEX;
  const candidates = [
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "openclaw", "dist", "index.js"),
    "/usr/local/lib/node_modules/openclaw/dist/index.js",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    const viaRuntime = api.runtime?.config ? null : null;
    void viaRuntime;
  } catch {}
  return null;
}
function injectWake(nodeBin, entry, wake) {
  return new Promise((resolve) => {
    const params = JSON.stringify({ key: wake.key, message: wake.message });
    const child = spawn(nodeBin, [entry, "gateway", "call", "sessions.send", "--params", params], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("error", (err) => resolve({ ok: false, detail: String(err) }));
    child.on("close", (code) => {
      let parsed = null;
      const s = out.indexOf("{"); const e = out.lastIndexOf("}");
      if (s >= 0 && e > s) { try { parsed = JSON.parse(out.slice(s, e + 1)); } catch {} }
      const ok = code === 0 && parsed && (parsed.status === "started" || parsed.status === "accepted" || parsed.runId);
      resolve({ ok: ok, detail: out.slice(0, 400) });
    });
  });
}

export default definePluginEntry({
  id: "session-wakes",
  name: "Session Wakes",
  description: "Schedule deferred zero-token wake injections into sessions.",
  register(api) {
    let cachedEntry;
    let entryProbed = false;
    function getEntry() {
      if (!entryProbed) {
        cachedEntry = resolveOpenclawEntry(api);
        entryProbed = true;
        try { api.logger.info("session-wakes injector entry: " + String(cachedEntry)); } catch {}
        try {
          const g = api.runtime && api.runtime.gateway;
          if (g) api.logger.info("runtime.gateway keys: " + Object.keys(g).join(","));
        } catch {}
      }
      return cachedEntry;
    }

    api.registerGatewayMethod("sessionwakes.wakes.list", async () => {
      const wakes = loadWakes().sort((a, b) => String(a.deliverAt || "").localeCompare(String(b.deliverAt || "")));
      return { wakes: wakes };
    }, { scope: "operator.read" });

    api.registerGatewayMethod("sessionwakes.wakes.create", async (request) => {
      const p = request.params || {};
      const key = String(p.key || "").trim();
      const message = String(p.message == null || p.message === "" ? "继续" : p.message);
      const deliverAt = p.deliverAt ? String(p.deliverAt) : null;
      if (!key.startsWith("agent:")) throw new Error("key must be a full sessionKey (agent:<agent>:<surface>:<uuid>)");
      if (!message) throw new Error("message required");
      if (deliverAt && Number.isNaN(Date.parse(deliverAt))) throw new Error("deliverAt must be an ISO time");
      const wake = { id: newId(), key: key, message: message, deliverAt: deliverAt, status: "pending", attempts: 0, createdAt: new Date().toISOString() };
      const wakes = loadWakes();
      wakes.push(wake);
      saveWakes(wakes);
      return { wake: wake };
    }, { scope: "operator.write" });

    api.registerGatewayMethod("sessionwakes.wakes.delete", async (request) => {
      const id = String(request.params && request.params.id || "");
      const wakes = loadWakes();
      const next = wakes.filter((w) => w.id !== id);
      const removed = next.length !== wakes.length;
      if (removed) saveWakes(next);
      return { removed: removed };
    }, { scope: "operator.write" });

    let timer = null;
    let stopped = true;
    let removeAbortListener = () => {};
    const stopInjector = () => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      removeAbortListener();
      removeAbortListener = () => {};
    };
    function persistWakeResult(wake) {
      const latest = loadWakes();
      const current = latest.find((item) => item.id === wake.id);
      if (!current) return; // Deletion during delivery must not resurrect a wake.
      for (const key of ["status", "attempts", "lastError", "firedAt"]) {
        if (Object.hasOwn(wake, key)) current[key] = wake[key];
      }
      saveWakes(latest); // Preserve wakes created while the CLI request was in flight.
    }
    api.registerService({
      id: "session-wakes-injector",
      start(ctx) {
        stopInjector();
        stopped = false;
        let busy = false;
        const tick = async () => {
          if (stopped || busy) return;
          busy = true;
          try {
            const wakes = loadWakes();
            const now = Date.now();
            const entry = getEntry();
            for (const w of wakes) {
              if (stopped) break;
              if (w.status !== "pending") continue;
              if (w.deliverAt && Date.parse(w.deliverAt) > now) continue;
              if (!entry) { w.status = "failed"; w.lastError = "openclaw entry not found (set OPENCLAW_DIST_INDEX)"; persistWakeResult(w); continue; }
              if ((w.attempts || 0) >= MAX_ATTEMPTS) { w.status = "failed"; w.lastError = w.lastError || "max attempts reached"; persistWakeResult(w); continue; }
              const res = await injectWake(process.execPath, entry, w);
              w.attempts = (w.attempts || 0) + 1;
              if (res.ok) { w.status = "fired"; w.firedAt = new Date().toISOString(); w.lastError = ""; }
              else {
                w.lastError = res.detail;
                if (w.attempts >= MAX_ATTEMPTS) w.status = "failed";
              }
              persistWakeResult(w);
            }
          } catch (e) {
            try { ctx.logger.warn("session-wakes tick failed: " + String(e)); } catch {}
          } finally { busy = false; }
        };
        timer = setInterval(tick, TICK_MS);
        const signal = ctx.signal || api.runtime?.signal;
        if (signal && signal.addEventListener) {
          signal.addEventListener("abort", stopInjector, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", stopInjector);
          if (signal.aborted) stopInjector();
        }
      },
      stop: stopInjector,
    });

    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "session-wakes",
      label: "Wakes",
      slug: "session-wakes",
      group: "control",
      requiredScopes: ["operator.read"],
    });
  },
});
