import { Buffer } from "node:buffer";
import { createPrivateKey, sign as signEd25519, type KeyObject } from "node:crypto";

const LEMON_LICENSE_VALIDATE_URL = "https://api.lemonsqueezy.com/v1/licenses/validate";
const LEMON_ORDER_URL = "https://api.lemonsqueezy.com/v1/orders/";
const EXCHANGE_PATH = "/license/exchange";
const MAX_BODY_BYTES = 8 * 1024;
const MAX_PURCHASE_KEY_LENGTH = 4096;
const DEFAULT_TIMEOUT_MS = 5000;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Signer = (privateKeyMaterial: string, data: Uint8Array) => string | Promise<string>;

export interface WorkerDeps {
  fetcher?: Fetcher;
  signer?: Signer;
  now?: () => Date;
  timeoutMs?: number;
}

type LicenseDetails = { licenseId: number; orderId: number; createdAt: string };
type Config = {
  storeId: number;
  productId: number;
  variantId: number;
  apiKey: string;
  testMode: boolean;
  privateKey: string;
};

class ExchangeError extends Error {
  constructor(readonly kind: "invalid-request" | "invalid-license" | "upstream" | "configuration") {
    super(kind);
    this.name = "ExchangeError";
  }
}

export function createLicenseExchangeWorker(deps: WorkerDeps = {}): ExportedHandler<Env> {
  const fetcher = deps.fetcher ?? fetch;
  const signer = deps.signer ?? signLicensePayload;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== EXCHANGE_PATH) return jsonResponse({ error: "not_found" }, 404);
      if (request.method !== "POST") {
        return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "POST" });
      }

      try {
        const clientIp = request.headers.get("CF-Connecting-IP")?.trim();
        const ipRateLimit = await limitOrFailClosed(
          env.IP_RATE_LIMITER,
          `ip:${clientIp || "unavailable"}`
        );
        if (!ipRateLimit) {
          return jsonResponse({ error: "rate_limited" }, 429, { "Retry-After": "60" });
        }

        const purchaseKey = await readPurchaseKey(request);
        const purchaseKeyDigest = await sha256Hex(purchaseKey);
        const purchaseKeyRateLimit = await limitOrFailClosed(
          env.PURCHASE_KEY_RATE_LIMITER,
          purchaseKeyDigest
        );
        if (!purchaseKeyRateLimit) {
          return jsonResponse({ error: "rate_limited" }, 429, { "Retry-After": "60" });
        }

        const config = readConfig(env);
        const details = await validateWithLemon(purchaseKey, config, fetcher, timeoutMs, now());
        const licenseKey = await issueAkc1(details, config.privateKey, signer);
        return jsonResponse({ licenseKey }, 200);
      } catch (error) {
        if (error instanceof ExchangeError) {
          if (error.kind === "invalid-request") return jsonResponse({ error: "invalid_request" }, 400);
          if (error.kind === "invalid-license") return jsonResponse({ error: "license_not_eligible" }, 403);
          if (error.kind === "upstream") {
            console.warn(JSON.stringify({ event: "license_exchange_upstream_failure" }));
            return jsonResponse({ error: "service_unavailable" }, 502);
          }
          console.error(JSON.stringify({ event: "license_exchange_configuration_failure" }));
          return jsonResponse({ error: "service_unavailable" }, 503);
        }
        console.error(JSON.stringify({ event: "license_exchange_unexpected_failure" }));
        return jsonResponse({ error: "internal_error" }, 500);
      }
    }
  } satisfies ExportedHandler<Env>;
}

async function limitOrFailClosed(limiter: RateLimit, key: string): Promise<boolean> {
  try {
    const result = await limiter.limit({ key });
    return result.success;
  } catch {
    throw new ExchangeError("configuration");
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readConfig(env: Env): Config {
  const storeId = positiveInteger(env.LEMON_STORE_ID);
  const productId = positiveInteger(env.LEMON_PRODUCT_ID);
  const variantId = positiveInteger(env.LEMON_VARIANT_ID);
  const testModeValue = String(env.LEMON_TEST_MODE);
  const testMode = testModeValue === "true" ? true : testModeValue === "false" ? false : null;
  if (
    storeId === null || productId === null || variantId === null || testMode === null ||
    env.LEMON_API_KEY.length === 0 || env.AKC_ED25519_PRIVATE_KEY.length === 0
  ) {
    throw new ExchangeError("configuration");
  }
  return {
    storeId,
    productId,
    variantId,
    apiKey: env.LEMON_API_KEY,
    testMode,
    privateKey: env.AKC_ED25519_PRIVATE_KEY
  };
}

async function readPurchaseKey(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) throw new ExchangeError("invalid-request");
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    throw new ExchangeError("invalid-request");
  }

  const raw = await readBoundedStream(request.body, MAX_BODY_BYTES, "invalid-request");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ExchangeError("invalid-request");
  }
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => key !== "licenseKey")) {
    throw new ExchangeError("invalid-request");
  }
  const purchaseKey = parsed.licenseKey;
  if (
    typeof purchaseKey !== "string" || purchaseKey.length === 0 ||
    purchaseKey.length > MAX_PURCHASE_KEY_LENGTH || purchaseKey.trim() !== purchaseKey || /[\r\n]/.test(purchaseKey)
  ) {
    throw new ExchangeError("invalid-request");
  }
  return purchaseKey;
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maximum: number,
  errorKind: "invalid-request" | "upstream",
  timeoutMs?: number
): Promise<string> {
  if (!stream) throw new ExchangeError(errorKind);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let timedOut = false;
  const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, timeoutMs);
  try {
    while (true) {
      const part = await reader.read();
      if (timedOut) throw new ExchangeError(errorKind);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw new ExchangeError(errorKind);
      }
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    reader.releaseLock();
  }
}

async function validateWithLemon(
  purchaseKey: string,
  config: Config,
  fetcher: Fetcher,
  timeoutMs: number,
  now: Date
): Promise<LicenseDetails> {
  const form = new URLSearchParams({ license_key: purchaseKey });
  const validationResponse = await safeFetch(fetcher, LEMON_LICENSE_VALIDATE_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString()
  }, timeoutMs);
  if (!validationResponse.ok) {
    if (validationResponse.status >= 400 && validationResponse.status < 500) {
      throw new ExchangeError("invalid-license");
    }
    throw new ExchangeError("upstream");
  }
  const details = parseLicenseValidation(await parseSmallJson(validationResponse, timeoutMs), config, now);

  const orderResponse = await safeFetch(fetcher, `${LEMON_ORDER_URL}${details.orderId}`, {
    headers: {
      Accept: "application/vnd.api+json",
      Authorization: `Bearer ${config.apiKey}`
    }
  }, timeoutMs);
  if (!orderResponse.ok) throw new ExchangeError("upstream");
  validatePaidOrder(await parseSmallJson(orderResponse, timeoutMs), details.orderId, config);
  return details;
}

function parseLicenseValidation(value: unknown, config: Config, now: Date): LicenseDetails {
  if (!isRecord(value) || value.valid !== true || !isRecord(value.license_key) || !isRecord(value.meta)) {
    throw new ExchangeError("invalid-license");
  }
  const license = value.license_key;
  const meta = value.meta;
  const licenseId = positiveInteger(license.id);
  const orderId = positiveInteger(meta.order_id);
  if (
    (license.status !== "inactive" && license.status !== "active") || licenseId === null || orderId === null ||
    positiveInteger(meta.store_id) !== config.storeId || positiveInteger(meta.product_id) !== config.productId ||
    positiveInteger(meta.variant_id) !== config.variantId || typeof license.created_at !== "string" ||
    !validIsoDate(license.created_at)
  ) {
    throw new ExchangeError("invalid-license");
  }
  if (license.expires_at !== null) {
    if (typeof license.expires_at !== "string" || !validIsoDate(license.expires_at) || Date.parse(license.expires_at) <= now.getTime()) {
      throw new ExchangeError("invalid-license");
    }
  }
  return { licenseId, orderId, createdAt: license.created_at };
}

function validatePaidOrder(value: unknown, orderId: number, config: Config): void {
  if (!isRecord(value)) throw new ExchangeError("upstream");
  const data = value.data;
  if (!isRecord(data)) throw new ExchangeError("upstream");
  const attributes = data.attributes;
  if (!isRecord(attributes)) throw new ExchangeError("upstream");
  if (
    data.type !== "orders" || String(data.id) !== String(orderId) ||
    positiveInteger(attributes.store_id) !== config.storeId || attributes.status !== "paid" ||
    attributes.refunded !== false || attributes.refunded_amount !== 0 || attributes.test_mode !== config.testMode
  ) {
    throw new ExchangeError("invalid-license");
  }
}

async function issueAkc1(details: LicenseDetails, privateKeyMaterial: string, signer: Signer): Promise<string> {
  const payload = {
    v: 1,
    plan: "pro",
    id: `ls_license_${details.licenseId}`,
    issuedAt: details.createdAt.slice(0, 10)
  } as const;
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signedData = Buffer.from(`AKC1.${payloadPart}`, "utf8");
  try {
    const signature = await signer(privateKeyMaterial, signedData);
    return `AKC1.${payloadPart}.${signature}`;
  } catch {
    throw new ExchangeError("configuration");
  }
}

function signLicensePayload(privateKeyMaterial: string, data: Uint8Array): string {
  // Keep the return conversion explicit. Worker ambient types expose a narrower
  // ArrayBuffer view than Node's Buffer API accepts in this call site.
  const signature = signEd25519(null, data, importSigningKey(privateKeyMaterial));
  return Buffer.from(signature).toString("base64url");
}

// AKC_ED25519_PRIVATE_KEY may hold either the PKCS#8 PEM or its single-line
// base64 DER body. The single-line form exists because `api-key-case save`
// accepts exactly one line, and placing this secret through the product
// itself (save -> deploy) is a supported bootstrap path. Anything that fails
// to import lands in the existing configuration fail-closed handling.
function importSigningKey(material: string): KeyObject {
  if (material.includes("-----BEGIN")) {
    return createPrivateKey(material);
  }
  return createPrivateKey({ key: Buffer.from(material, "base64"), format: "der", type: "pkcs8" });
}

async function safeFetch(fetcher: Fetcher, input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } catch {
    throw new ExchangeError("upstream");
  } finally {
    clearTimeout(timeout);
  }
}

async function parseSmallJson(response: Response, timeoutMs: number): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    throw new ExchangeError("upstream");
  }
  const text = await readBoundedStream(response.body, MAX_BODY_BYTES, "upstream", timeoutMs);
  try {
    return JSON.parse(text);
  } catch {
    throw new ExchangeError("upstream");
  }
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function validIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(body: Record<string, string>, status: number, extraHeaders: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders
    }
  });
}

export default createLicenseExchangeWorker();
