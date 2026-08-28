# License exchange Workers

Exchanges a Lemon Squeezy purchase license key for the existing offline-verifiable `AKC1` format at `POST /license/exchange`.

## Resource separation

| Mode | Wrangler config | Worker name | `LEMON_TEST_MODE` | purchase-key limiter | IP limiter |
| --- | --- | --- | --- | --- | --- |
| test | `wrangler.test.jsonc` | `api-key-case-license-exchange-test` | config-fixed `true` | namespace `2001`, 5/min | namespace `2002`, 30/min |
| bootstrap | `wrangler.jsonc` | `api-key-case-license-exchange` | config-fixed `false` | namespace `1001`, 5/min | namespace `1002`, 30/min |
| live | `wrangler.live.jsonc` | `api-key-case-license-exchange` | config-fixed `false` | namespace `1001`, 5/min | namespace `1002`, 30/min |

The bootstrap config is not a separate Worker: it is the same Worker name as live, deployed with `workers_dev: false`, `preview_urls: false`, and no `secrets.required` guard, so it has no public route and shares live's limiter namespaces (it IS the live Worker, just not exposed and not yet fully configured). See "Live Worker" below for why it exists.

The four namespace IDs are deliberately distinct because Cloudflare bindings with the same `namespace_id` share counters, even across Workers. Confirm that these IDs are reserved for this service in the target Cloudflare account before the first deployment; if the account already uses one, replace it with another positive integer while preserving four-way uniqueness.

The purchase key is SHA-256 hashed in the Worker before the purchase-key binding is called. Neither plaintext nor digest is logged, returned, or included in an error. The IP binding uses `CF-Connecting-IP`; requests without that header share the conservative `ip:unavailable` bucket. Either binding throwing or being unavailable fails closed before Lemon is called or AKC1 is issued.

## Values to configure after Lemon setup

Set all five secrets independently on each Worker, using values from the matching Lemon mode:

- `LEMON_STORE_ID`
- `LEMON_PRODUCT_ID`
- `LEMON_VARIANT_ID`
- `LEMON_API_KEY`
- `AKC_ED25519_PRIVATE_KEY` — the existing PKCS#8 private key matching `EMBEDDED_PUBLIC_KEY_PEM`, accepted in either of two formats: the PKCS#8 PEM itself, or its single-line base64 DER body (see "Live Worker" below for converting between the two)

Do not enter `LEMON_TEST_MODE`: each config fixes it as a non-secret variable. Do not generate or substitute a new production signing key merely to make setup pass. Manual `npx wrangler secret put` remains a valid alternative to the self-placement flow below for any of the five secrets.

## Test Worker

For local development, copy `.dev.vars.example` to `.dev.vars` without committing it, fill it only with Lemon test-mode values, and run:

```sh
npx wrangler dev --config workers/license-exchange/wrangler.test.jsonc
```

Configure the remote test Worker interactively. Wrangler prompts for each value without placing it in argv:

```sh
npx wrangler secret put LEMON_STORE_ID --config workers/license-exchange/wrangler.test.jsonc
npx wrangler secret put LEMON_PRODUCT_ID --config workers/license-exchange/wrangler.test.jsonc
npx wrangler secret put LEMON_VARIANT_ID --config workers/license-exchange/wrangler.test.jsonc
npx wrangler secret put LEMON_API_KEY --config workers/license-exchange/wrangler.test.jsonc
npx wrangler secret put AKC_ED25519_PRIVATE_KEY --config workers/license-exchange/wrangler.test.jsonc

npx wrangler deploy --dry-run --config workers/license-exchange/wrangler.test.jsonc
npx wrangler deploy --config workers/license-exchange/wrangler.test.jsonc
```

## Live Worker

The live Worker cannot take its five secrets by manual `wrangler secret put` the way the test Worker does — dogfooding demands it be provisioned the same way this product provisions any other Worker, via `api-key-case`. But `wrangler secret put` cannot target a Worker that doesn't exist yet, and `wrangler.live.jsonc` refuses to deploy without all five secrets already present (`secrets.required`). `wrangler.jsonc` breaks that chicken-and-egg problem: it is the same Worker name, `workers_dev: false`, `preview_urls: false`, no `secrets.required`, so it can deploy the Worker privately with zero secrets first.

Use only live Lemon store/product/variant IDs and a live API key. In order:

1. Deploy the private bootstrap Worker. This is safe even with zero secrets configured: the runtime fails closed with `503` on every request, and there is no public route anyway.

   ```sh
   npx wrangler deploy --config workers/license-exchange/wrangler.jsonc
   ```

2. Convert the signing key to the single-line form `api-key-case save` can accept (it takes exactly one line of input):

   ```sh
   node tools/convert-signing-key.mjs <path-to-pem> | clip
   ```

   `<path-to-pem>` means the actual path of the existing issuer private key;
   do not create a file or directory with that placeholder name. Keep the real
   path and backup location in a private operator record, not this repository.

3. `api-key-case save` each of the five secrets with live Lemon values (`LEMON_STORE_ID`, `LEMON_PRODUCT_ID`, `LEMON_VARIANT_ID`, `LEMON_API_KEY`, `AKC_ED25519_PRIVATE_KEY`). This puts each value in the OS secret store, never in a file or shell history.

4. Place each secret on the bootstrap Worker, run from `workers/license-exchange/` where the adapter detects the default-named `wrangler.jsonc`:

   ```sh
   api-key-case deploy <NAME> --target cloudflare --env production
   ```

   for each of the five names above. The value flows OS store -> wrangler stdin only; it never passes through an AI or a file. `deploy` is Pro-gated, so install and verify the maintainer license first using the bootstrap instructions in `tools/README.md`; the buyer-only `license activate` command cannot install a self-issued maintainer license.

5. Verify all five secrets are present, then deploy the live config, which enforces `secrets.required` and turns on the custom-domain route for the first time:

   ```sh
   npx wrangler deploy --dry-run --config workers/license-exchange/wrangler.live.jsonc
   npx wrangler deploy --config workers/license-exchange/wrangler.live.jsonc
   ```

Only the deployed live HTTPS endpoint belongs in `LICENSE_EXCHANGE_URL` in `packages/core/license-exchange.ts`. The npm publish workflow remains blocked while that URL or the Lemon purchase URL contains its explicit placeholder marker. The test Worker URL must never be compiled into the CLI.

**Footgun:** after launch, a bare `wrangler deploy` run from `workers/license-exchange/` picks up the default-named `wrangler.jsonc` (the bootstrap config, `workers_dev: false`) and takes the public route *down*. Redeploying with `--config workers/license-exchange/wrangler.live.jsonc` restores it. This is the intended failure orientation: a mistaken bare deploy fails private, never public.

## Validation commands

```sh
npx wrangler types workers/license-exchange/worker-configuration.d.ts --include-runtime false --config workers/license-exchange/wrangler.live.jsonc
npx wrangler deploy --dry-run --config workers/license-exchange/wrangler.test.jsonc
npx wrangler deploy --dry-run --config workers/license-exchange/wrangler.jsonc
npx wrangler deploy --dry-run --config workers/license-exchange/wrangler.live.jsonc
```

## Why Orders API is called

License API `validate` establishes that the purchase key and exact product identifiers are valid, but Lemon's documentation does not guarantee refund-to-license disablement for one-time purchases. The authenticated order lookup additionally requires a fully paid, zero-refund order. This is why `LEMON_API_KEY` is required.

No D1 or webhook is used: immutable license ID + creation date makes AKC1 issuance deterministic. Already-issued offline licenses are intentionally not remotely revocable.
