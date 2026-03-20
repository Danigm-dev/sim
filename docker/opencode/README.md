# OpenCode Service

This service runs `opencode serve` for SIMAI. It backs the `OpenCode` workflow block and can also be queried by internal tooling against one or more cloned repositories.

## What it provides

- HTTP service on `http://opencode:4096` inside Docker, plus a published host port in `docker-compose.local.yml`
- HTTP basic auth via `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`
- Persistent OpenCode storage in `~/.local/share/opencode`
- Optional multi-repo sync into `/app/repos`
- Global read-only OpenCode permissions

## Required configuration

At minimum, set:

```env
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=change-me
OPENCODE_REPOS=https://github.com/octocat/Hello-World.git
GEMINI_API_KEY=your-gemini-key
```

Notes:

- `OPENCODE_SERVER_USERNAME` defaults to `opencode` in local and prod compose if omitted.
- `docker-compose.local.yml` defaults `OPENCODE_SERVER_PASSWORD` to `dev-opencode-password`, but setting it explicitly is safer and avoids app/container credential drift.
- `docker-compose.prod.yml` requires `OPENCODE_SERVER_PASSWORD` to be provided from the environment.
- OpenCode needs at least one provider key to answer prompts:
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `GEMINI_API_KEY`
  - `GOOGLE_GENERATIVE_AI_API_KEY`
- In local and prod compose, `GOOGLE_GENERATIVE_AI_API_KEY` is automatically derived from `GEMINI_API_KEY` if not set explicitly.

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

## Local development on the host

If you run `next dev` on the host instead of inside Docker, the app must reach OpenCode through the published host port.

Add this to `apps/sim/.env`:

```env
OPENCODE_BASE_URL=http://127.0.0.1:4096
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=change-me
```

Then load the same environment into your shell before starting the OpenCode container:

```bash
set -a
source apps/sim/.env
set +a
docker compose -f docker-compose.local.yml up -d --build opencode
```

This matters because `apps/sim/.env` configures the host-side Next.js app, but `docker compose` only sees variables present in the shell environment.

## Verify the service

Verification differs slightly between local and production-style compose.

### Local compose

`docker-compose.local.yml` publishes `OPENCODE_PORT` to the host, so this should work from the host:

```bash
curl -u "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" \
  http://127.0.0.1:${OPENCODE_PORT:-4096}/global/health
```

Create a session from the host:

```bash
curl -u "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"title":"test"}' \
  http://127.0.0.1:${OPENCODE_PORT:-4096}/session
```

### Production-style compose

`docker-compose.prod.yml` keeps OpenCode internal to the Docker network, so verify from another container:

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

Useful runtime checks:

```bash
docker logs --tail 100 sim-opencode-1
docker exec sim-opencode-1 env | grep OPENCODE
docker exec sim-opencode-1 env | grep -E 'OPENAI|ANTHROPIC|GEMINI|GOOGLE_GENERATIVE'
```

Expected signals:

- `opencode server listening on http://0.0.0.0:4096`
- `[opencode-sync] Updated <repo-name>` or clone logs
- the same username/password and provider env vars you expect the app to use

Before accepting a deployment, validate the read-only permission config with a real prompt against a cloned repository. The check should confirm that OpenCode can still read files while `edit`, `bash`, and web-capable tools remain blocked. If the wildcard rule prevents normal reads, remove `permission."*": "deny"` and keep the explicit tool denies as the fallback.

## Repo-specific behavior

Each cloned repository can keep its own `AGENTS.md` and `opencode.json` at the repo root. OpenCode will use those when a future client targets that repository directory.

The SDK also supports injecting extra per-session context without triggering a reply by calling `session.prompt` with `noReply: true`. The current SIMAI block can evolve to use this for dynamic skills or runtime instructions on top of the static `AGENTS.md` committed in the repository.

Use [`AGENTS.example.md`](./AGENTS.example.md) as a starting template for repository owners.

## Notes

- Session retention is not managed yet. OpenCode data persists until the `opencode_data` volume is pruned.
- The SIMAI `OpenCode` block already uses this service in the current repository.
