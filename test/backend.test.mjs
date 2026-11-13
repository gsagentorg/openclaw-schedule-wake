import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const key = "agent:test:webchat:YOUR-SESSION-HERE";
const sourceFile = fileURLToPath(new URL("../index.js", import.meta.url));
async function harness(run) {
  const dir = mkdtempSync(path.join(tmpdir(), "schedule-wake-test-"));
  const state = path.join(dir, "wakes.json"), cli = path.join(dir, "cli.mjs");
  const previous = { state: process.env.OPENCLAW_WAKES_FILE, cli: process.env.OPENCLAW_DIST_INDEX };
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  const timers = new Map(); let serial = 0, service;
  process.env.OPENCLAW_WAKES_FILE = state; process.env.OPENCLAW_DIST_INDEX = cli;
  writeFileSync(cli, 'console.log("Gateway call: sessions.send"); console.log(JSON.stringify({status:"started",runId:"YOUR-RUN-ID-HERE"}));');
  globalThis.setInterval = (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms }); return id; };
  globalThis.clearInterval = (id) => timers.delete(id);
  try {
    const original = readFileSync(sourceFile, "utf8");
    const sdk = 'import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";';
    assert.equal(original.split(sdk).length - 1, 1);
    const code = original.replace(sdk, "const definePluginEntry = (entry) => entry;");
    const module = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64") + "#" + randomUUID());
    const methods = new Map();
    const logger = { info() {}, warn() {} };
    module.default.register({ logger, runtime: {}, registerGatewayMethod(name, fn, policy) { methods.set(name, { fn, policy }); }, registerService(s) { service = s; }, session: { controls: { registerControlUiDescriptor() {} } } });
    const call = (method, params = {}) => methods.get("sessionwakes.wakes." + method).fn({ params });
    const controller = new AbortController();
    const h = { state, cli, methods, timers, service, controller, call,
      create: (params = {}) => call("create", { key, ...params }),
      read: () => JSON.parse(readFileSync(state, "utf8")),
      start: () => service.start({ logger, signal: controller.signal }),
      tick: () => [...timers.values()][0].fn(),
    };
    await run(h);
  } finally {
    service?.stop(); globalThis.setInterval = realSet; globalThis.clearInterval = realClear;
    if (previous.state === undefined) delete process.env.OPENCLAW_WAKES_FILE; else process.env.OPENCLAW_WAKES_FILE = previous.state;
    if (previous.cli === undefined) delete process.env.OPENCLAW_DIST_INDEX; else process.env.OPENCLAW_DIST_INDEX = previous.cli;
    rmSync(dir, { recursive: true, force: true }); // Only files created by this isolated test.
  }
}

test("read is read-only; create/delete require write scope", () => harness(async h => {
  assert.equal(h.methods.get("sessionwakes.wakes.list").policy.scope, "operator.read");
  for (const name of ["create", "delete"]) assert.equal(h.methods.get("sessionwakes.wakes." + name).policy.scope, "operator.write");
  assert.deepEqual(await h.call("list"), { wakes: [] });
  const { wake } = await h.create(); assert.equal(wake.key, key); assert.equal(wake.message, "继续");
  assert.equal(wake.deliverAt, null); assert.equal(wake.status, "pending");
  await assert.rejects(h.create({ key: "not-a-session" }));
  await assert.rejects(h.create({ deliverAt: "bad-time" }));
  assert.equal(h.read().length, 1);
  assert.deepEqual(await h.call("delete", { id: wake.id }), { removed: true });
  assert.deepEqual(await h.call("delete", { id: wake.id }), { removed: false });
}));

test("start, stop and abort clean up the timer", () => harness(async h => {
  h.start(); assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].ms, 10000);
  h.start(); assert.equal(h.timers.size, 1);
  h.service.stop(); assert.equal(h.timers.size, 0);
  h.start(); h.controller.abort(); assert.equal(h.timers.size, 0);
  h.start(); assert.equal(h.timers.size, 0, "already-aborted lifetime cannot start polling");
}));

test("due wake is delivered once through a fake local CLI; future wake is retained", () => harness(async h => {
  const { wake } = await h.create();
  const { wake: future } = await h.create({ deliverAt: new Date(Date.now() + 3600000).toISOString() });
  h.start(); await h.tick(); await h.tick();
  const result = h.read().find(w => w.id === wake.id); assert.equal(result.status, "fired"); assert.equal(result.attempts, 1);
  assert.equal(h.read().find(w => w.id === future.id).attempts, 0);
}));

test("attempt cap persists failure without launching another delivery", () => harness(async h => {
  const { wake } = await h.create(); const list = h.read(); list[0].attempts = 3; writeFileSync(h.state, JSON.stringify(list));
  h.start(); await h.tick(); const result = h.read().find(w => w.id === wake.id);
  assert.equal(result.status, "failed"); assert.equal(result.attempts, 3); assert.match(result.lastError, /max attempts/);
}));

test("delivery result preserves concurrent creation and does not resurrect deletion", () => harness(async h => {
  writeFileSync(h.cli, 'setTimeout(() => console.log(JSON.stringify({status:"started",runId:"YOUR-RUN-ID-HERE"})), 100);');
  const { wake } = await h.create(); h.start(); const delivery = h.tick();
  const { wake: future } = await h.create({ message: "YOUR-NEW-MESSAGE-HERE", deliverAt: new Date(Date.now() + 3600000).toISOString() });
  await h.call("delete", { id: wake.id }); await delivery;
  assert.deepEqual(h.read().map(w => w.id), [future.id]);
}));

test("malformed state is surfaced and never overwritten", () => harness(async h => {
  for (const invalid of ["not-json", "{}"]) {
    writeFileSync(h.state, invalid); await assert.rejects(h.call("list")); await assert.rejects(h.create());
    assert.equal(readFileSync(h.state, "utf8"), invalid);
  }
}));

test("failed fake CLI replies retry at most three times", () => harness(async h => {
  writeFileSync(h.cli, 'console.log(JSON.stringify({status:"error"})); process.exitCode=1;');
  await h.create(); h.start();
  for (let i = 1; i <= 3; i++) { await h.tick(); assert.equal(h.read()[0].attempts, i); }
  assert.equal(h.read()[0].status, "failed"); await h.tick(); assert.equal(h.read()[0].attempts, 3);
}));
