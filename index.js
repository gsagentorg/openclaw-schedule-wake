import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const STATE_FILE = process.env.OPENCLAW_WAKES_FILE
  || path.join(os.homedir(), ".openclaw", "session-wakes", "wakes.json");
const TICK_MS = 10000;
const MAX_ATTEMPTS = 3;
const WAIT_TIMEOUT_MS = Number(process.env.SESSION_WAKES_WAIT_MS || 120000);

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
function callGateway(nodeBin, entry, method, params) {
  return new Promise((resolve) => {
    const child = spawn(nodeBin, [entry, "gateway", "call", method, "--params", JSON.stringify(params)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("error", (err) => resolve({ code: -1, parsed: null, out: String(err) }));
    child.on("close", (code) => {
      let parsed = null;
      const s = out.indexOf("{"); const e = out.lastIndexOf("}");
      if (s >= 0 && e > s) { try { parsed = JSON.parse(out.slice(s, e + 1)); } catch {} }
      resolve({ code: code, parsed: parsed, out: out });
    });
  });
}
async function injectWake(nodeBin, entry, wake) {
  const r = await callGateway(nodeBin, entry, "sessions.send", {
    key: wake.key,
    message: wake.message,
    // Stable per-wake key: a transport retry after an ambiguous response is
    // deduplicated by the gateway instead of running the turn twice.
    idempotencyKey: wake.id,
  });
  const parsed = r.parsed;
  const runId = parsed && typeof parsed.runId === "string" ? parsed.runId : undefined;
  const ok = r.code === 0 && parsed && (parsed.status === "started" || parsed.status === "accepted" || runId);
  return { ok: ok, runId: runId, detail: String(r.out).slice(0, 400) };
}
// Success means "the wake turn did not come back as an error". A timeout is
// not evidence of failure, so it stays a delivery success and is never re-sent.
async function waitForWake(nodeBin, entry, runId) {
  const r = await callGateway(nodeBin, entry, "agent.wait", { runId: runId, timeoutMs: WAIT_TIMEOUT_MS });
  const parsed = r.parsed;
  if (!parsed) return { failed: false, detail: String(r.out).slice(0, 400) };
  if (parsed.status === "error") {
    return { failed: true, detail: String(parsed.error || r.out).slice(0, 400) };
  }
  return { failed: false, detail: "" };
}

export default definePluginEntry({
  id: "session-wakes",
  name: "Session Wakes",
  description: "Schedule deferred zero-token wake injections into sessions.",
  register(api) {
    let cachedEntry;
    let entryProbed = false;
    const inflight = new Set();
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
      for (const key of ["status", "attempts", "lastError", "firedAt", "runId", "retryable", "waitedAt"]) {
        if (Object.hasOwn(wake, key)) current[key] = wake[key];
      }
      saveWakes(latest); // Preserve wakes created while the CLI request was in flight.
    }
    function markRunFailed(wake, runId, detail) {
      const latest = loadWakes();
      const current = latest.find((item) => item.id === wake.id);
      // Only a still-delivered wake may be downgraded; never resurrect a
      // deleted wake and never overwrite a newer delivery of the same wake.
      if (!current || current.status !== "fired" || current.runId !== runId) return;
      current.status = "failed";
      current.retryable = false;
      current.lastError = "wake turn failed: " + (detail || "error");
      current.waitedAt = new Date().toISOString();
      saveWakes(latest);
    }
    function watchRun(wake, runId, entry) {
      const task = (async () => {
        const result = await waitForWake(process.execPath, entry, runId);
        if (stopped || !result.failed) return;
        markRunFailed(wake, runId, result.detail);
      })().catch(() => {}).finally(() => inflight.delete(task));
      inflight.add(task);
    }
    api.registerService({
      id: "session-wakes-injector",
      // Test seam only: lets the suite await asynchronous run verification.
      whenIdle: () => Promise.allSettled([...inflight]),
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
              if (res.ok) {
                w.status = "fired";
                w.firedAt = new Date().toISOString();
                w.lastError = "";
                w.retryable = false;
                if (res.runId) { w.runId = res.runId; }
              }
              else {
                w.lastError = res.detail;
                if (w.attempts >= MAX_ATTEMPTS) w.status = "failed";
              }
              persistWakeResult(w);
              // An accepted send is never retried: re-injecting would run the
              // turn twice. Only the outcome of the first turn may fail it.
              if (res.ok && res.runId) watchRun(w, res.runId, entry);
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
