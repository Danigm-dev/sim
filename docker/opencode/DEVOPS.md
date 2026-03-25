# OpenCode DevOps Guide

This guide is for the production deployment of the internal OpenCode service that powers the `OpenCode` workflow block.

## Deployment model

- Keep the upstream-style Sim deployment in `docker-compose.prod.yml`.
- Deploy OpenCode as a separate overlay using `docker-compose.opencode.yml`.
- Run both compose files together so `simstudio` and `opencode` share the same Docker network and service discovery.

Production command:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.opencode.yml up -d
```

The overlay does two things:

- starts the `opencode` container
- injects the `OPENCODE_*` runtime variables into `simstudio`

Without those `simstudio` variables, the app cannot authenticate against the OpenCode server.

## Required variables

These variables must be available to the compose deployment environment:

```env
OPENCODE_IMAGE=ghcr.io/your-org/opencode:2026-03-23
OPENCODE_PORT=4096
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=change-me
OPENCODE_REPOS=https://github.com/org/repo-a.git,https://github.com/org/repo-b.git
```

If OpenCode must clone private repositories, also provide one of these credential sets:

```env
GIT_USERNAME=your-user
GIT_TOKEN=your-token
```

or:

```env
GITHUB_TOKEN=your-github-token
```

OpenCode also needs at least one model provider key:

```env
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
GOOGLE_GENERATIVE_AI_API_KEY=...
```

## What CI/CD Must Do

1. Publish a versioned OpenCode image to your registry.
2. Inject the required OpenCode secrets and provider keys into the deploy environment.
3. Deploy with both compose files, not only `docker-compose.prod.yml`.
4. Keep the `opencode_data` and `opencode_repos` volumes persistent across rollouts.
5. Verify post-deploy connectivity from `simstudio` to `opencode`.

## Post-Deploy Verification

Verify the OpenCode health endpoint from inside `simstudio`:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.opencode.yml exec simstudio \
  curl -u "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" \
  "http://opencode:${OPENCODE_PORT:-4096}/global/health"
```

Create a session:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.opencode.yml exec simstudio \
  curl -u "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"title":"deploy-check"}' \
  "http://opencode:${OPENCODE_PORT:-4096}/session"
```

Inspect logs:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.opencode.yml logs --tail=100 opencode
docker compose -f docker-compose.prod.yml -f docker-compose.opencode.yml logs --tail=100 simstudio
```

Expected signals:

- `opencode` is healthy
- `simstudio` can reach `http://opencode:4096`
- repositories are cloned or updated under `/app/repos`
- the OpenCode block dropdowns load providers, models, agents, and repositories

## Rollback

- Roll back `simstudio` independently from `opencode` when the upstream release changes.
- Roll back `opencode` by pinning `OPENCODE_IMAGE` to the previous known-good tag.
- Do not remove the OpenCode volumes during normal rollback unless you intentionally want to drop sessions and cloned repositories.

## Operational Notes

- `docker-compose.prod.yml` should stay close to upstream.
- `docker-compose.opencode.yml` is the deployment customization layer owned by infra.
- If the upstream deployment model changes, migrate the same contract:
  `simstudio` must still receive `OPENCODE_BASE_URL`, `OPENCODE_PORT`, `OPENCODE_SERVER_USERNAME`, and `OPENCODE_SERVER_PASSWORD`.
