import { setTimeout as sleep } from "node:timers/promises";

export const APPLICATION_STARTUP_TIMEOUT_MS = 120000;
export const DEFAULT_READINESS_TIMEOUT_MS = 45000;
export const REQUEST_TIMEOUT_MS = 5000;

export class FixtureReadinessTimeoutError extends Error {
  constructor() {
    super("Local fixture readiness deadline exceeded");
    this.name = "FixtureReadinessTimeoutError";
  }
}

export async function waitForReady(callback, {
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
  now = () => performance.now(),
  sleep: pause = sleep,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Readiness timeout must be finite and positive");
  }
  const deadline = now() + timeoutMs;
  const controller = new AbortController();
  let expired = false;
  const timeout = sleep(timeoutMs, undefined, { signal: controller.signal }).then(() => {
    expired = true;
    throw new FixtureReadinessTimeoutError();
  });
  async function poll() {
    while (!expired && now() < deadline) {
      if (await callback()) {
        if (!expired && now() <= deadline) return;
        break;
      }
      const remaining = deadline - now();
      if (expired || remaining <= 0) break;
      await pause(Math.min(500, remaining), undefined, { signal: controller.signal });
    }
    throw new FixtureReadinessTimeoutError();
  }
  try {
    await Promise.race([poll(), timeout]);
  } finally {
    controller.abort();
  }
}

export function runtimeOptions(args) {
  if (args.length === 0) {
    return {
      image: "sha256:89564de1640a94638c706dc546e4a343f71f563eefe3c21e2f5824b14f44ae9e",
      bindCompiledServer: true,
    };
  }
  if (args.length !== 2 || args[0] !== "--image" || !/^sha256:[0-9a-f]{64}$/.test(args[1])) {
    throw new Error("Use --image with an existing local sha256 image digest");
  }
  return { image: args[1], bindCompiledServer: false };
}

const errorTypes = new Set([
  "Error", "TypeError", "TimeoutError", "AbortError", "AssertionError",
  "FixtureReadinessTimeoutError",
]);
const errorCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
]);

export function safeFixtureError(error) {
  return {
    type: errorTypes.has(error?.name) ? error.name : "UnknownError",
    ...(errorCodes.has(error?.code) ? { code: error.code } : {}),
    ...(errorCodes.has(error?.cause?.code) ? { causeCode: error.cause.code } : {}),
  };
}
