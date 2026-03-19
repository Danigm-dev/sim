# OpenCode Service

This service runs `opencode serve` as an internal HTTP service for SIMAI. It is intended for future workflow blocks or internal tooling that need to query one or more code repositories through OpenCode without exposing the service outside Docker.

## What it provides

- Internal-only HTTP service on `http://opencode:4096`
- HTTP basic auth via `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`
- Persistent OpenCode storage in `~/.local/share/opencode`
- Optional multi-repo sync into `/app/repos`
- Global read-only OpenCode permissions

## Configure repositories

Set `OPENCODE_REPOS` to a comma-separated list of HTTPS repository URLs.

```bash
OPENCODE_REPOS=https://github.com/org/ui-components,https://github.com/org/design-tokens
```

Azure Repos over HTTPS is also supported. Example:

```bash
OPENCODE_REPOS=https://dev.azure.com/org/project/_git/repo
```

Each repository is cloned into `/app/repos/<repo-name>`. On restart, existing clones are updated with `git pull --ff-only`. A background cron sync retries every 15 minutes.

For private repositories, provide HTTPS credentials with one of these options:

- `GIT_USERNAME` and `GIT_TOKEN`
- `GITHUB_TOKEN` for GitHub HTTPS access

For Azure Repos, use `GIT_USERNAME` plus an Azure DevOps PAT in `GIT_TOKEN`. The container uses non-interactive `GIT_ASKPASS`, so it will not stop to ask for a password in the terminal during clone or pull.

If a clone or pull fails, the service logs the error and continues syncing the remaining repositories.

## Verify the service

Start the service with Docker Compose, then verify health from another service attached to the same Compose network. OpenCode does not publish a host port, so `http://localhost:4096` on the host is expected to fail.

```bash
docker compose exec simstudio \
  curl -u "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" \
  http://opencode:${OPENCODE_PORT:-4096}/global/health
```

Create a session:

```bash
docker compose exec simstudio \
  curl -u "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"title":"test"}' \
  http://opencode:${OPENCODE_PORT:-4096}/session
```

Before accepting a deployment, validate the read-only permission config with a real prompt against a cloned repository. The check should confirm that OpenCode can still read files while `edit`, `bash`, and web-capable tools remain blocked. If the wildcard rule prevents normal reads, remove `permission."*": "deny"` and keep the explicit tool denies as the fallback.

## Repo-specific behavior

Each cloned repository can keep its own `AGENTS.md` and `opencode.json` at the repo root. OpenCode will use those when a future client targets that repository directory.

The SDK also supports injecting extra per-session context without triggering a reply by calling `session.prompt` with `noReply: true`. The future SIMAI block can use this to add dynamic skills or runtime instructions on top of the static `AGENTS.md` committed in the repository.

Use [`AGENTS.example.md`](./AGENTS.example.md) as a starting template for repository owners.

## Notes

- Session retention is not managed yet. OpenCode data persists until the `opencode_data` volume is pruned.
- This service is infrastructure only. No SIMAI block, API route, or workflow runtime integration is included here.
