# Security Policy

## Supported versions

Security fixes land on the latest published `@dsh-miaowu/dsh` release. Report issues against `main`.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private
[Report a vulnerability](https://github.com/zuiyi233/dsh-miaowu/security/advisories/new)
form instead. Include the DSH version, the plugin version, and a reproduction. We aim to
acknowledge within 72 hours.

Vulnerabilities in DeepSeek Harness itself belong to the
[upstream project](https://github.com/deepseek-ai/deepseek-harness).

## Trust boundary

`@dsh-miaowu/dsh` is a Cordis plugin inside a DSH process. DSH owns models, credentials, sandbox policy, tool permissions and approvals. The plugin opens no network listener of its own and starts no second agent runtime. Host preflight checks whether media credentials are set; it returns configuration status, not key values. Media adapters run through the current DSH execution environment.

Media and provider keys are host environment variables. The plugin reports only whether they are configured and never sends key values to the browser. The optional credential vault is off by default (`DSH_MIAOWU_VAULT_ENABLED`); while disabled, its routes return 403 and write nothing. Full backups can include `.oh-story/` text state (including vault ciphertext when the vault is enabled), so treat backups as sensitive and verify what one contains before sharing or migrating it.

The plugin mounts `/oh-story` routes on DSH's existing web server for creative files, read-only media and game previews, and runtime preflight:

- **Browser trust.** Workspace, file, media and preflight requests apply Host, `Origin` and Fetch Metadata checks matching DSH's native API boundary. Only loopback authorities are trusted by default. A non-loopback deployment must declare each authority in `trustedHosts`; malformed entries fail plugin loading. Generated-game previews additionally allow isolated document navigation under a trusted Host and apply a restrictive CSP to preview responses.
- **Session scoping.** Workspace paths come from the DSH Session, never a request-supplied working directory. Child-Agent Sessions receive no editor route. The bundled game is a separate read-only example.
- **Path containment.** Creative file access uses an allowlist of directories and extensions, including the documented novel, short-drama, `game-adaptations` and `video-recaps` roots. The current Agent's DSH `FileSystem` resolves paths and checks containment in its workspace. Workspace game-preview assets are additionally confined to that game's `build/app` directory; media previews are extension-allowlisted and read-only.
- **Concurrent writes.** Reads return the DSH filesystem's opaque version. Writes use atomic `replaceIfVersion` with that version and the current Session's sandbox policy, rejecting stale saves instead of overwriting concurrent changes.

## Bundled upstream content

Oh Story's login/CDP rank scrapers and Drama Skills' standalone dashboard server are excluded
during synchronization, and the build fails if either reappears in the release bundle. The two
scan Skills ship DSH-native instructions that use only visible tools and do not bypass
captchas, paywalls, or access controls.
