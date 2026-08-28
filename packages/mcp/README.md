# API Key Case MCP

Optional, for intermediate users. The CLI remains the primary interface —
this just lets an agent host (Claude Code, Cursor, Codex) call the same
status-only operations directly. See `docs/design/phase-4-mcp.md` for the
full spec.

Start it with:

```
npx api-key-case mcp [path]
```

Register it with a client:

```
# Claude Code
claude mcp add api-key-case -- npx -y api-key-case mcp

# Cursor (mcp.json)
{ "mcpServers": { "api-key-case": { "command": "npx", "args": ["-y", "api-key-case", "mcp"] } } }
```

## Security boundary

This package exposes exactly 7 tools, all a subset of the CLAUDE.md 3.1
allowlist: `list_required_secrets`, `check_secret`, `save_secret`,
`deploy_secret`, `generate_env_example`, `scan_secret_leaks`,
`check_gitignore`. None of them can return, accept, or transmit a real
secret value:

- `save_secret` has no `value`/`secret`/`password` parameter and never
  touches the vault — it returns an `action_required` response asking a
  human to run `api-key-case save` themselves.
- `deploy_secret` never completes a `production` deploy (or a `github`
  deploy, whose secret is CI-consumed regardless of `--env`). Those return an
  `action_required` response asking a human to run `api-key-case deploy`
  in their own terminal. The engine's production-confirm callback is
  hardwired to always answer "no", as a second layer of defense.
- `deploy_secret` is a Pro feature (`docs/design/phase-5-license.md`). Without
  an active license it returns a normal (non-`isError`) status with a
  purchase link instead of deploying — every other tool stays free
  regardless of license state.
- Every tool response is built only from the same status objects the CLI
  itself renders — never from a secret value, and never from a raw
  exception message or stack trace.
- Transport is stdio only. There is no network listener.

API Key Case reduces the risk of an accidental secret leak; it does not
guarantee complete safety.
