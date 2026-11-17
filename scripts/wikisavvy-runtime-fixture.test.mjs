import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLICATION_STARTUP_TIMEOUT_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  FixtureReadinessTimeoutError,
  runtimeOptions,
  safeFixtureError,
  waitForReady,
} from "./wikisavvy-runtime-fixture.mjs";

function clock() {
  let elapsed = 0;
  const sleeps = [];
  return {
    now: () => elapsed,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      elapsed += milliseconds;
    },
    advance: (milliseconds) => { elapsed += milliseconds; },
    sleeps,
  };
}

test("only application startup gets the longer readiness budget", () => {
  assert.equal(APPLICATION_STARTUP_TIMEOUT_MS, 120000);
  assert.equal(DEFAULT_READINESS_TIMEOUT_MS, 45000);
  assert.equal(REQUEST_TIMEOUT_MS, 5000);
});

test("ready immediately does not sleep", async () => {
  const time = clock();
  await waitForReady(async () => true, time);
  assert.deepEqual(time.sleeps, []);
});

test("accepts the observed 81-second startup within the application budget", async () => {
  const time = clock();
  await waitForReady(async () => time.now() >= 81500, {
    ...time, timeoutMs: APPLICATION_STARTUP_TIMEOUT_MS,
  });
  assert.equal(time.now(), 81500);
});

test("the default wait still rejects the same slow readiness", async () => {
  const time = clock();
  await assert.rejects(
    waitForReady(async () => time.now() >= 81500, time),
    FixtureReadinessTimeoutError,
  );
  assert.equal(time.now(), 45000);
});

test("never-ready application fails at its finite deadline", async () => {
  const time = clock();
  await assert.rejects(
    waitForReady(async () => false, { ...time, timeoutMs: APPLICATION_STARTUP_TIMEOUT_MS }),
    FixtureReadinessTimeoutError,
  );
  assert.equal(time.now(), 120000);
});

test("caps the final sleep and does not probe after the deadline", async () => {
  const time = clock();
  let calls = 0;
  await assert.rejects(waitForReady(async () => { calls++; return false; }, {
    ...time, timeoutMs: 1200,
  }), FixtureReadinessTimeoutError);
  assert.equal(calls, 3);
  assert.deepEqual(time.sleeps, [500, 500, 200]);
  assert.equal(time.now(), 1200);
});

test("callback time counts toward the readiness deadline", async () => {
  const time = clock();
  await assert.rejects(waitForReady(async () => {
    time.advance(1500);
    return true;
  }, { ...time, timeoutMs: 1200 }), FixtureReadinessTimeoutError);
  assert.deepEqual(time.sleeps, []);
});

test("does not swallow unexpected probe failures", async () => {
  const time = clock();
  const error = new Error("synthetic-private-detail");
  await assert.rejects(waitForReady(async () => { throw error; }, time),
    (actual) => actual === error);
  assert.deepEqual(time.sleeps, []);
});

test("a probe that never settles cannot bypass the deadline", { timeout: 1000 }, async () => {
  await assert.rejects(
    waitForReady(() => new Promise(() => {}), { timeoutMs: 10 }),
    FixtureReadinessTimeoutError,
  );
});

test("rejects invalid readiness budgets instead of an unbounded wait", async () => {
  for (const timeoutMs of [0, -1, Infinity, NaN]) {
    await assert.rejects(waitForReady(async () => true, { timeoutMs }), RangeError);
  }
});

test("preserves compiled-server mode when no release image is supplied", () => {
  const options = runtimeOptions([]);
  assert.equal(options.bindCompiledServer, true);
  assert.match(options.image, /^sha256:[0-9a-f]{64}$/);
});

test("immutable image mode disables the compiled-server bind mount", () => {
  const image = `sha256:${"a".repeat(64)}`;
  assert.deepEqual(runtimeOptions(["--image", image]), {
    image, bindCompiledServer: false,
  });
});

test("rejects missing images, mutable tags, invalid digests and unknown arguments", () => {
  for (const args of [
    ["--image"], ["--image", "latest"], ["--image", "example/image:latest"],
    ["--image", `sha256:${"a".repeat(63)}`],
    ["--image", `sha256:${"g".repeat(64)}`],
    ["--image", `sha256:${"a".repeat(64)}`, "--ignore-errors"],
    ["--unknown"],
  ]) {
    assert.throws(() => runtimeOptions(args));
  }
});

test("safe diagnostics retain known timeout and transport classifications", () => {
  assert.deepEqual(safeFixtureError(new FixtureReadinessTimeoutError()), {
    type: "FixtureReadinessTimeoutError",
  });
  assert.deepEqual(safeFixtureError(Object.assign(new Error(), {
    name: "TimeoutError", code: "ETIMEDOUT", cause: { code: "UND_ERR_SOCKET" },
  })), { type: "TimeoutError", code: "ETIMEDOUT", causeCode: "UND_ERR_SOCKET" });
});

test("safe diagnostics omit private messages, stacks and unknown codes", () => {
  const error = { name: "synthetic-private-name", message: "synthetic-private-message",
    code: "synthetic-private-code", stack: "synthetic-private-stack",
    cause: { code: "synthetic-private-cause" } };
  assert.deepEqual(safeFixtureError(error), { type: "UnknownError" });
  assert.equal(JSON.stringify(safeFixtureError(error)).includes("synthetic-private"), false);
  assert.deepEqual(safeFixtureError(undefined), { type: "UnknownError" });
});
