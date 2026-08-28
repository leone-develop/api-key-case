# Verification record

What has actually been run against real systems, with the evidence to back it
up. A separate, unpublished release checklist decides *whether we may ship*;
this file records *what was proven, when, and how to reproduce it*.

A claim belongs here only if it was observed. "The code does X" is not
verification; a run that shows X is. Where something is unverified, or rests
on a memory rather than an artifact, this file says so — an honest gap is more
useful than a checkbox that nobody can trace back.

## Status at a glance

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Unit + integration suite | ✅ 2026-08-10 | ✅ 2026-08-10 | ✅ 2026-08-10 |
| Real OS secret store round-trip | ✅ 2026-08-10 | ✅ 2026-08-10 | ✅ 2026-08-10 |
| **Real `deploy` to Cloudflare / Vercel / GitHub** | ✅ **2026-08-18** | ✅ **2026-08-18** | ✅ **2026-08-18** |
| Survives a host with no secret store | n/a | ✅ Docker, 2026-08-10 | n/a |

All three advertised platforms are now covered by a reproducible run against
the real services. Runner images: `macos-latest` (macos-26, arm64),
`ubuntu-latest` (ubuntu-24.04), `windows-latest` (windows-2025-vs2026). Intel
macOS is not covered by any of this.

These pre-launch runs were made in a Private publication-staging repository.
That staging repository was retired instead of being made Public because its
pre-release history contained development-only files. The records remain in
the Private evidence archive and are intentionally not linked from this Public
history. The workflow and assertions needed to reproduce them are published
below; new runs made from the Public repository can be linked directly.

## Real deploy end-to-end (the headline result)

Workflow: `.github/workflows/e2e-deploy.yml` → `tests/e2e/deploy-e2e.sh`.
Manual dispatch only, because every run creates and destroys real resources in
real accounts.

- **macOS**, 2026-08-18, `macos-latest` (macos-26, arm64). Cloudflare, Vercel, GitHub: all green. Vendor CLIs: wrangler 4.123.0, vercel 59.1.4, gh 2.96.0.
- **Linux**, 2026-08-18, `ubuntu-latest` (ubuntu-24.04). Cloudflare, Vercel, GitHub: all green. Vendor CLIs: wrangler 4.124.0, vercel 59.1.4, gh 2.97.0.
- **Windows**, 2026-08-18, `windows-latest` (windows-2025-vs2026). Cloudflare, Vercel, GitHub: all green. Vendor CLIs: wrangler 4.124.0, vercel 59.1.4, gh 2.97.0. Node 24.19.0. Runs under Git Bash, which ships with the runner image.

The vendor CLIs are installed globally on purpose — `resolveCli()` searches
`PATH` only and never `node_modules/.bin`
(`packages/core/deploy/which.ts`), so anything else would test a path users
never take.

### What each run actually asserted

Per platform, in order. Every one of these is a hard assertion; the script
fails the job rather than warning.

1. **A throwaway resource is provisioned** in the real account — a Worker (with `workers_dev = false`, so it never gets a public hostname), a Vercel project, or a private GitHub repo.
2. **`targets` sees a real, logged-in CLI** — detection reason, version and login state all come from the shipped adapter, not from the harness.
3. **The value is stored in the real OS secret store.** `check --json` must report `backend=keyring`; a fall back to an in-memory backend fails the run, so this can never silently pass against a dead vault.
4. **The store is confirmed from outside the product** — `security find-generic-password` on macOS, `secret-tool` on Linux (matched on attribute `service`), `cmdkey /list` on Windows (target `{account}.api-key-case`). None is ever asked for the value: `security` runs without `-w`, `cmdkey` never prints passwords at all, and `secret-tool`'s stdout — which does include the value — goes only into `grep`, never to a file or the log.
5. **`--dry-run` prints the plan and changes nothing.**
6. **Declining the confirmation deploys nothing.** Typing `no` at the production prompt must exit 4. Checked for Cloudflare (`--env production`) and GitHub (which always confirms, since a GitHub secret of either kind is CI-consumed regardless of `--env`).
7. **The real deploy runs** and reports `OK: ... deployed to ...`.
8. **The service itself confirms the registration** — this is the point of the whole exercise, and it is read back from the platform, not from our own output:
   - Cloudflare: `wrangler secret list` → `[{"name":"AKC_E2E_CANARY","type":"secret_text"}]`
   - Vercel: `vercel env ls` → `AKC_E2E_CANARY | Non-sensitive | Development`
   - GitHub: `gh api repos/.../actions/secrets` → `AKC_E2E_CANARY`
9. **The value leaked nowhere.** A fresh random canary per run must appear in no transcript, plan, service listing, or file in the project directory.
10. **Everything is deleted, and the deletion is verified** — CLI delete plus a direct REST delete, then a `GET` that must return 404 (`gh repo view` must fail for GitHub). A resource that might survive raises a `::warning::` naming it.

### Why the harness types into a pseudo-terminal

`save` and the production confirmation refuse non-TTY input, and AGENTS.md §3
forbids adding a bypass ("there is no flag to skip this"). So the harness must
not gain a `--stdin` escape hatch to make itself testable — it allocates a real
terminal and types like a human: a pty on macOS and Linux
(`tests/e2e/pty-drive.py`), a ConPTY on Windows (`tests/e2e/pty-drive.mjs`,
see [below](#how-windows-gets-a-terminal)). The product under test is the
shipped one, with no test-only flag in its path.

Three consequences worth knowing before editing the harness:

- **Echo has to be suppressed, or the harness frames the product.** A terminal echoes typed input straight back. A human never hits that window because `readHiddenLine()` turns echo off first, but the harness answers within microseconds and does. Leaving it on made the first real run (32129207315) fail the leak check on all three platforms against a value the *harness* had typed, not one the product printed. POSIX clears `ECHO` on the pty; ConPTY does not expose that, so the Windows driver waits 250 ms after the prompt — roughly a human's reaction time — before typing.
- **The leak check reads an unmasked transcript.** The driver writes a masked copy for the log and a mode-600 raw copy that is never printed; the assertion greps the raw one. Grepping the masked copy would be circular — the mask would hide the leak it was looking for.
- **A wrapped line could hide a leak.** A terminal may hard-wrap a long line, splitting a leaked value across a newline where a plain `grep` would miss it. The leak check therefore also greps a whitespace-flattened copy. ConPTY repaints make this a real possibility rather than a theoretical one.

### Reproducing or re-running

> **The credentials this needs were deliberately removed on 2026-08-19.** The
> harness is kept for regression use, not run on a schedule, so leaving live
> tokens sitting in a repository that is due to go public bought nothing. A
> dispatch today fails at the preflight step, by design, naming what is
> missing. That is expected, not a regression.

```sh
gh workflow run e2e-deploy.yml                                         # defaults: all platforms, ubuntu only
gh workflow run e2e-deploy.yml -f platforms=cloudflare                 # one leg, cheapest
gh workflow run e2e-deploy.yml -f platforms=all -f os=all              # everything (9 legs; macOS bills 10x)
```

Needs five repository secrets. Only three are actually tokens to mint:

| Secret | To restore |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | New token, "Edit Cloudflare Workers" template |
| `VERCEL_TOKEN` | New token at vercel.com/account/tokens |
| `GH_PAT_E2E` | New classic PAT, `repo` + `delete_repo` only — `GITHUB_TOKEN` can neither write Actions secrets nor delete repos |
| `CLOUDFLARE_ACCOUNT_ID` | Not a secret: `wrangler whoami` prints it |
| `AKC_PRO_LICENSE_KEY` | The maintainer license already on disk at `~/.api-key-case/license.key` (deploy is Pro-gated; exit 6 without it) |

The three tokens above were revoked at their providers, not just unset here,
so they cannot be reused. Note that GitHub Actions secrets are write-only —
there is no API to read one back — which is also why revoking them had to be
done by hand in each dashboard.

Linux needs a Secret Service that the vault can reach, so the whole flow runs
inside one `dbus-run-session`. Starting the daemon in an earlier step does not
work: the bus address dies with that step's shell. The workflow asserts
`org.freedesktop.secrets` is on the bus *before* running the flow, so an
infrastructure failure is never misread as a product defect.

## How Windows gets a terminal

Windows needed its own solution, because the product's TTY requirement is a
guarantee rather than an inconvenience. `tests/e2e/pty-drive.py` uses
`pty`/`termios`, which do not exist on Windows, and the tempting alternative —
giving the CLI a non-TTY input path so a test could reach it — would have
deleted the very property the test exists to confirm.

ConPTY (Windows 10 1809+) is the equivalent primitive: it gives the child a
real console handle, so `process.stdin.isTTY` is true and the hidden-input
path runs exactly as it does for a user. `tests/e2e/pty-drive.mjs` drives it
through `node-pty`, taking the same arguments as the Python driver so
`deploy-e2e.sh` picks one by `uname`. `node-pty` is installed with
`--no-save` on the Windows leg only — a harness dependency must not appear in
what users install.

Two Windows-specific things worth knowing before touching this:

- **The whole flow runs under Git Bash**, which rewrites arguments that look like absolute paths. That silently broke the first attempt: `cmdkey /list` arrived as a Windows path and was rejected as a bad parameter, which the check then reported as "the credential is missing". `//list` is the MSYS escape that arrives as `/list`, and the check now separates "cmdkey listed nothing at all" from "the credential is absent".
- **`node-pty` does no PATH lookup on Windows** and fails with `File not found` on a bare command name, so the driver resolves its own launcher. That is unrelated to the product's deliberately PATH-only vendor-CLI resolution.

### What was already known about Windows

Independently of the runs above, and still true:

- Real Credential Manager behaviour: `getPassword()` returns `null` (not a throw) for a missing entry, and `deleteCredential()` returns `false`. Checked on real hardware 2026-07, which is why `packages/core/deploy/handoff.ts` tests existence by return value rather than by exception (`docs/design/phase-2-vault.md` §4.3).
- The older `deploy` value-path e2e ran against real Credential Manager but with a **fake CLI fixture** on `pathOverride` (`docs/design/phase-3-deploy.md`). It covered vault → stdin only. The 2026-08-18 Windows pre-launch run closes the remaining half, against the real vendor CLIs.

## Supporting verification

- **Unit + integration suite and real-keyring round-trip**, 2026-08-10 Private pre-launch record. Five `test` legs (ubuntu 20/22/24, macos 24, windows 24) plus `keyring-e2e` on all three OSes. `keyring-e2e` runs with `AGENT_KEY_CASE_E2E_STRICT=1`, which turns "backend unavailable → skip" into a hard error and asserts at least one e2e block ran, so it cannot pass by silently skipping.
- **No secret store at all**, Docker `node:24-slim` (Debian bookworm), 2026-08-10, installed from the packed tarball with no libsecret and `DBUS_SESSION_BUS_ADDRESS` unset. `--version` / `scan` / `targets` exit 0; `list` / `check` print the guidance and exit 3 with no stack trace. Confirms the static `createVault` import does not break vault-free commands. CI structurally cannot cover this, because the Linux leg installs gnome-keyring first.

## Findings that changed the product or its docs

Things the runs surfaced that were not known beforehand:

- **Vercel's `development` environment cannot hold a sensitive variable** (Vercel's API disallows it), so a value deployed there is readable again via `vercel env pull`. `production` and `preview` default to sensitive; Cloudflare and GitHub secrets are not readable back at all. Documented in README ("What each platform does with the value after that") and in SECURITY.md's known limitations, since it changes what a user should expect from `--env development`.
- **Teardown depended on `vercel project rm --yes`**, a flag Vercel does not document. A failed run could have left a project behind in a real account. Cleanup now deletes via CLI *and* REST and asserts the resource is gone.
- **Windows Credential Manager stores the entry as `{account}.{service}`** — established by writing a throwaway entry and reading `cmdkey /list` back, rather than assumed from the keyring library's source. The Linux attribute name (`service`) was pinned the same way, by trying the known spellings and reporting which matched.

## Not verified

Deliberately listed so nobody mistakes silence for coverage:

- **Intel macOS** — `macos-latest` is arm64.
- **Windows versions other than the runner image.** The Windows leg proves the flow on `windows-2025-vs2026`. ConPTY needs Windows 10 1809 or newer; older builds are not covered, and neither is a Windows host without Git Bash (the script's shell).
- **Dogfooding the license backend**: placing the live Worker's five secrets with the product itself is still an open checklist item.
- **Long-lived behaviour** — every run here is a single-shot create/deploy/delete on a fresh runner. Nothing covers a value that has sat in a store across OS updates, keychain re-locks, or credential rotation.
