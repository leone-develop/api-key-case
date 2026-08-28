import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createLicenseExchangeWorker, sha256Hex } from "../dist/index.js";
import { parseLicenseKey } from "../../../dist/core/license.js";

const purchaseCanary = "LS-PURCHASE-CANARY-DO-NOT-LOG";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const baseValidation = {
  valid: true,
  error: null,
  license_key: {
    id: 41,
    status: "inactive",
    key: purchaseCanary,
    activation_limit: null,
    activation_usage: 0,
    created_at: "2026-07-10T12:34:56.000000Z",
    expires_at: null
  },
  instance: null,
  meta: {
    store_id: 11,
    order_id: 21,
    order_item_id: 31,
    product_id: 51,
    variant_id: 61,
    customer_email: "must-not-be-returned@example.invalid"
  }
};

const baseOrder = {
  data: {
    type: "orders",
    id: "21",
    attributes: {
      store_id: 11,
      status: "paid",
      refunded: false,
      refunded_amount: 0,
      test_mode: true,
      user_email: "must-not-be-returned@example.invalid"
    }
  }
};

const env = {
  LEMON_STORE_ID: "11",
  LEMON_PRODUCT_ID: "51",
  LEMON_VARIANT_ID: "61",
  LEMON_API_KEY: ["test", "api", "key", "never", "logged"].join("-"),
  LEMON_TEST_MODE: "true",
  AKC_ED25519_PRIVATE_KEY: privateKeyPem,
  PURCHASE_KEY_RATE_LIMITER: allowAllLimiter(),
  IP_RATE_LIMITER: allowAllLimiter()
};

await testSuccessfulExchange();
await testSuccessfulExchangeWithBase64DerKey();
await testGarbageKeyMaterialFailsClosed();
await testInvalidLicense();
await testInvalidStatuses();
await testIdentifierMismatches();
await testRefundedOrder();
await testTimeout();
await testMalformedUpstream();
await testDeterministicExchange();
await testSha256IsDeterministic();
await testSamePurchaseKeyIsLimited();
await testDifferentKeysHitIpLimit();
await testFewRequestsOnSharedIpAreAllowed();
await testCanaryNeverReachesRateLimiterInPlaintext();
await testMissingIpUsesSharedFailSafeBucket();
await testRateLimiterFailureFailsClosed();
console.log("worker tests passed");

async function testSuccessfulExchange() {
  const { response, logs } = await invoke(sequenceFetcher(baseValidation, baseOrder));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(Object.keys(body).join(","), "licenseKey");
  assert.deepEqual(parseLicenseKey(body.licenseKey, publicKey), {
    plan: "pro",
    entitlementId: "ls_license_41",
    issuedAt: "2026-07-10"
  });
  assertNoCanary(JSON.stringify(body).replace(body.licenseKey, ""));
  assertNoCanary(logs);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
}

// The same key as a single-line base64 PKCS#8 DER (the format `api-key-case
// save` can hold) must issue licenses identical to the PEM form.
async function testSuccessfulExchangeWithBase64DerKey() {
  const derKey = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const environment = { ...env, AKC_ED25519_PRIVATE_KEY: derKey };
  const { response, logs } = await invoke(sequenceFetcher(baseValidation, baseOrder), { environment });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(parseLicenseKey(body.licenseKey, publicKey), {
    plan: "pro",
    entitlementId: "ls_license_41",
    issuedAt: "2026-07-10"
  });
  assertNoCanary(logs);
}

async function testGarbageKeyMaterialFailsClosed() {
  const environment = { ...env, AKC_ED25519_PRIVATE_KEY: "not-a-key-in-any-format" };
  const { response, text, logs } = await invoke(sequenceFetcher(baseValidation, baseOrder), { environment });
  assert.equal(response.status, 503);
  assert.equal(text.includes("AKC1."), false);
  assertNoCanary(text);
  assertNoCanary(logs);
}

async function testInvalidLicense() {
  const invalid = clone(baseValidation);
  invalid.valid = false;
  const { response, text, logs } = await invoke(sequenceFetcher(invalid, baseOrder));
  assert.equal(response.status, 403);
  assertNoCanary(text);
  assertNoCanary(logs);
}

async function testInvalidStatuses() {
  for (const status of ["disabled", "expired"]) {
    const validation = clone(baseValidation);
    validation.license_key.status = status;
    const { response } = await invoke(sequenceFetcher(validation, baseOrder));
    assert.equal(response.status, 403);
  }
}

async function testIdentifierMismatches() {
  for (const [field, value] of [["store_id", 999], ["product_id", 999], ["variant_id", 999]]) {
    const validation = clone(baseValidation);
    validation.meta[field] = value;
    const { response } = await invoke(sequenceFetcher(validation, baseOrder));
    assert.equal(response.status, 403, field);
  }
}

async function testRefundedOrder() {
  const order = clone(baseOrder);
  order.data.attributes.status = "partial_refund";
  order.data.attributes.refunded_amount = 100;
  const { response } = await invoke(sequenceFetcher(baseValidation, order));
  assert.equal(response.status, 403);
}

async function testTimeout() {
  const fetcher = (_input, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const { response, text, logs } = await invoke(fetcher, { timeoutMs: 5 });
  assert.equal(response.status, 502);
  assertNoCanary(text);
  assertNoCanary(logs);
}

async function testMalformedUpstream() {
  const { response, text, logs } = await invoke(async () => new Response("not-json", { status: 200 }));
  assert.equal(response.status, 502);
  assertNoCanary(text);
  assertNoCanary(logs);
}

async function testDeterministicExchange() {
  const first = await invoke(sequenceFetcher(baseValidation, baseOrder));
  const second = await invoke(sequenceFetcher(baseValidation, baseOrder));
  assert.equal((await first.response.json()).licenseKey, (await second.response.json()).licenseKey);
}

async function testSha256IsDeterministic() {
  const first = await sha256Hex(purchaseCanary);
  const second = await sha256Hex(purchaseCanary);
  const expected = createHash("sha256").update(purchaseCanary, "utf8").digest("hex");
  assert.equal(first, second);
  assert.equal(first, expected);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first.includes(purchaseCanary), false);
}

async function testSamePurchaseKeyIsLimited() {
  const ip = recordingLimiter(30);
  const purchase = recordingLimiter(5);
  const environment = { ...env, IP_RATE_LIMITER: ip.binding, PURCHASE_KEY_RATE_LIMITER: purchase.binding };
  const fetcher = sequenceFetcher(baseValidation, baseOrder);
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const { response } = await invoke(fetcher, { environment });
    assert.equal(response.status, attempt <= 5 ? 200 : 429);
  }
  assert.equal(new Set(purchase.keys).size, 1, "the same purchase key must map to one limiter key");
  assert.equal(purchase.keys[0], await sha256Hex(purchaseCanary), "only the SHA-256 digest may reach the binding");
  assert.equal(purchase.keys.length, 6);
  assertNoCanary(JSON.stringify(purchase.keys));
}

async function testDifferentKeysHitIpLimit() {
  const ip = recordingLimiter(30);
  const purchase = recordingLimiter(5);
  const environment = { ...env, IP_RATE_LIMITER: ip.binding, PURCHASE_KEY_RATE_LIMITER: purchase.binding };
  const fetcher = sequenceFetcher(baseValidation, baseOrder, null);
  for (let attempt = 1; attempt <= 31; attempt += 1) {
    const key = `LS-DIFFERENT-KEY-${attempt}`;
    const { response } = await invoke(fetcher, { environment, purchaseKey: key });
    assert.equal(response.status, attempt <= 30 ? 200 : 429);
  }
  assert.equal(ip.keys.length, 31);
  assert.equal(new Set(ip.keys).size, 1);
  assert.equal(purchase.keys.length, 30, "the rejected IP request must not reach purchase-key limiting");
  assert.equal(new Set(purchase.keys).size, 30);
}

async function testFewRequestsOnSharedIpAreAllowed() {
  const ip = recordingLimiter(30);
  const purchase = recordingLimiter(5);
  const environment = { ...env, IP_RATE_LIMITER: ip.binding, PURCHASE_KEY_RATE_LIMITER: purchase.binding };
  const fetcher = sequenceFetcher(baseValidation, baseOrder, null);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { response } = await invoke(fetcher, { environment, purchaseKey: `LS-NORMAL-${attempt}` });
    assert.equal(response.status, 200);
  }
}

async function testCanaryNeverReachesRateLimiterInPlaintext() {
  const ip = recordingLimiter(30);
  const purchase = recordingLimiter(5);
  const environment = { ...env, IP_RATE_LIMITER: ip.binding, PURCHASE_KEY_RATE_LIMITER: purchase.binding };
  const { response, text, logs } = await invoke(sequenceFetcher(baseValidation, baseOrder), { environment });
  assert.equal(response.status, 200);
  assertNoCanary(JSON.stringify(ip.keys));
  assertNoCanary(JSON.stringify(purchase.keys));
  assertNoCanary(text.replace((await response.clone().json()).licenseKey, ""));
  assertNoCanary(logs);
}

async function testMissingIpUsesSharedFailSafeBucket() {
  const ip = recordingLimiter(30);
  const environment = { ...env, IP_RATE_LIMITER: ip.binding };
  const { response } = await invoke(sequenceFetcher(baseValidation, baseOrder), { environment, ip: null });
  assert.equal(response.status, 200);
  assert.deepEqual(ip.keys, ["ip:unavailable"]);
}

async function testRateLimiterFailureFailsClosed() {
  for (const failedBinding of ["IP_RATE_LIMITER", "PURCHASE_KEY_RATE_LIMITER"]) {
    let upstreamCalls = 0;
    let signingCalls = 0;
    const environment = {
      ...env,
      [failedBinding]: { limit: async () => { throw new Error("limiter unavailable"); } }
    };
    const worker = createLicenseExchangeWorker({
      fetcher: async () => {
        upstreamCalls += 1;
        return Response.json(clone(baseValidation));
      },
      signer: async () => {
        signingCalls += 1;
        return "must-not-be-issued";
      }
    });
    const { response, text, logs } = await invokeWorker(worker, environment);
    assert.equal(response.status, 503);
    assert.equal(upstreamCalls, 0);
    assert.equal(signingCalls, 0);
    assert.equal(text.includes("AKC1."), false);
    assertNoCanary(text);
    assertNoCanary(logs);
  }
}

async function invoke(fetcher, options = {}) {
  const worker = createLicenseExchangeWorker({
    fetcher,
    timeoutMs: options.timeoutMs ?? 100,
    now: () => new Date("2026-07-13T00:00:00.000Z")
  });
  return invokeWorker(worker, options.environment ?? env, options);
}

async function invokeWorker(worker, environment, options = {}) {
  const lines = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const response = await worker.fetch(request(options.purchaseKey ?? purchaseCanary, options.ip), environment, {});
    const cloneResponse = response.clone();
    return { response, text: await cloneResponse.text(), logs: lines.join("\n") };
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
}

function request(purchaseKey, ip = "192.0.2.1") {
  const headers = { "Content-Type": "application/json" };
  if (ip !== null) headers["CF-Connecting-IP"] = ip;
  return new Request("https://licenses.example.invalid/license/exchange", {
    method: "POST",
    headers,
    body: JSON.stringify({ licenseKey: purchaseKey })
  });
}

function sequenceFetcher(validation, order, expectedPurchaseKey = purchaseCanary) {
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/licenses/validate")) {
      assert.equal(init.method, "POST");
      if (expectedPurchaseKey !== null) {
        assert.equal(new URLSearchParams(init.body).get("license_key"), expectedPurchaseKey);
      }
      return Response.json(clone(validation));
    }
    assert.equal(url, "https://api.lemonsqueezy.com/v1/orders/21");
    assert.equal(init.headers.Authorization, `Bearer ${env.LEMON_API_KEY}`);
    return Response.json(clone(order));
  };
}

function allowAllLimiter() {
  return { limit: async () => ({ success: true }) };
}

function recordingLimiter(maximum) {
  const keys = [];
  const counts = new Map();
  return {
    keys,
    binding: {
      limit: async ({ key }) => {
        keys.push(key);
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return { success: count <= maximum };
      }
    }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertNoCanary(value) {
  assert.equal(value.includes(purchaseCanary), false);
  assert.equal(value.includes("must-not-be-returned@example.invalid"), false);
  assert.equal(value.includes(env.LEMON_API_KEY), false);
  assert.equal(value.includes("BEGIN PRIVATE KEY"), false);
}
