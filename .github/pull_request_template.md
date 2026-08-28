## Summary

Describe the user-visible change and why it is needed.

## Security boundary

State whether this changes secret input, storage, scanning, redaction, logging, deploy targets, production confirmation, MCP schemas, or license exchange. If none, say so explicitly.

## Verification

- [ ] Tests use fake canary values only.
- [ ] No `.env`, credential, purchase key, license key, signing material, account ID, or personal data is included.
- [ ] `npm test` passes.
- [ ] `npm pack --dry-run` contains only intended public files.
- [ ] User-facing documentation and product claims are updated where needed.
