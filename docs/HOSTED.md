# Hosted mode

`litmustest serve --hosted --repo owner/name` runs the dashboard for a team that has no local checkout. The server clones the repository as a GitHub App, people sign in with GitHub, and every save is a commit on an `evals/<slug>` pull-request branch, authored by the person who made it. Nothing reaches the base branch until a person merges that pull request.

**Status: built, not deployed.** No GitHub App has been registered for litmustest and nothing is running anywhere. The code is tested against a fake GitHub API (an injected `fetch`) and a local bare repository as the remote (`tests/hosted.test.ts`). It has never talked to github.com. Treat the first real deployment as a test of this document; the checklist at the end says what to verify.

## How it works

The server keeps a real clone on disk, so validation and every route work exactly as they do locally. Only three things change (`packages/cli/src/server/hosted.ts`):

| Local | Hosted |
| --- | --- |
| Reads and writes your checkout | Reads and writes its own clone of `owner/name` |
| A save is an uncommitted change; you commit from the Pending tray | A save is a commit on `evals/<slug>`, pushed, with a pull request opened on the first save |
| Anyone who can reach `127.0.0.1` can write | Sign in with GitHub; a write needs write permission on the repository |

One save, step by step:

1. The request carries a signed session cookie. No cookie: `401` for `/api/*`, a redirect to `/auth/login` for pages.
2. For a write, the server asks GitHub for the person's permission on the repository (cached five minutes). Below write: `403`.
3. The write goes through the same validated path as locally (`App.putFile`, `putFiles`, `appendLabel`, and the calibrate, draft and dispute routes). A refused write leaves no commit.
4. `App.wrote` fires. In hosted mode it commits everything under `evals/` with the person as author (`Name <id+login@users.noreply.github.com>`) and `litmustest` as committer, on `evals/<date>-<first file>`.
5. Before the request is answered the server pushes. If someone else pushed to the branch first, it fetches and replays the commit on top. If both touched the same lines, their version is kept, yours is dropped, and the save answers `409` so the editor asks you to reload.
6. If the branch has no pull request, one is opened over the REST API against the base branch.

Labels, triage and expected flips are recorded under the signed-in login, whatever the request body says.

A background fetch (every 60 seconds) picks up other people's pushes and notices when the pull request is merged or closed; the server then returns to the base branch and the next save starts a new branch and pull request.

## Register the GitHub App

Create the App under the organisation that owns the repository (Settings → Developer settings → GitHub Apps → New GitHub App), or post this manifest through GitHub's [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). Replace `https://evals.example.com` with the address the server will be reached at.

```json
{
  "name": "litmustest (your-org)",
  "url": "https://evals.example.com",
  "redirect_url": "https://evals.example.com",
  "callback_urls": ["https://evals.example.com/auth/callback"],
  "public": false,
  "request_oauth_on_install": false,
  "hook_attributes": { "url": "https://evals.example.com/healthz", "active": false },
  "default_permissions": {
    "contents": "write",
    "pull_requests": "write",
    "metadata": "read"
  },
  "default_events": []
}
```

- **Contents: read and write** to clone, and to push `evals/*` branches.
- **Pull requests: read and write** to open the pull request.
- **Metadata: read** (mandatory) to read a collaborator's permission.
- No webhook is used; the server polls.
- No user permissions are requested. Sign-in only reads who the person is (`GET /user`); the person's token is used once and discarded.

Then:

1. Generate a private key (downloads a `.pem`).
2. Generate a client secret. Note the App ID and the client ID.
3. Install the App on the one repository it should serve.
4. Protect the base branch so the App cannot push to it directly. Hosted mode never tries to, but branch protection is what guarantees that a person merges.

## Environment

| Variable | Required | What it is |
| --- | --- | --- |
| `LITMUSTEST_APP_ID` | yes | The App ID (a number). |
| `LITMUSTEST_APP_PRIVATE_KEY` | yes | The private key: the PEM itself, the PEM with newlines written as `\n`, or the PEM base64-encoded on one line (`base64 -w0 key.pem`). |
| `LITMUSTEST_APP_CLIENT_ID` | yes | The App's client ID, for sign-in. |
| `LITMUSTEST_APP_CLIENT_SECRET` | yes | The App's client secret. |
| `LITMUSTEST_SESSION_SECRET` | yes | At least 32 characters; signs the session cookie. `openssl rand -hex 32`. Changing it signs everyone out. |
| `LITMUSTEST_PUBLIC_URL` | in production | The address people use, e.g. `https://evals.example.com`. Used for the OAuth callback, the cookie's `Secure` flag and the same-origin check on writes. Without it the server trusts the request's `Host` header, which is only acceptable on a trusted network. |
| `LITMUSTEST_REPO` | no | `owner/name`, instead of `--repo`. |
| `LITMUSTEST_WORKDIR` | no | Where the clone lives. Default `~/.litmustest/hosted/<owner>__<name>`. Put it on a volume so a restart does not re-clone. |
| `LITMUSTEST_GITHUB_API`, `LITMUSTEST_GITHUB_URL` | no | For GitHub Enterprise Server: `https://ghe.example.com/api/v3` and `https://ghe.example.com`. Untested. |
| `ANTHROPIC_API_KEY` | for model actions | Regroup notes, draft a judge or a check, calibrate, and explain a failure all call the model from the server. |

Flags: `--repo owner/name`, `--dir evals` (the evals directory inside the repository), `--base main` (default: the remote's default branch), `--port 4242`, `--host 0.0.0.0`, `--workdir path`.

The local server (`litmustest serve` without `--hosted`) has no sign-in and refuses any `--host` other than this machine.

## Dockerfile

litmustest is not on npm yet, so the image builds from this repository. **This Dockerfile has not been built**: Docker is not installed where it was written.

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev
RUN mkdir /data && chown node:node /data
USER node
ENV LITMUSTEST_WORKDIR=/data/clone
VOLUME /data
EXPOSE 4242
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4242/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["sh", "-c", "exec node packages/cli/dist/main.js serve --hosted --repo \"$LITMUSTEST_REPO\" --port 4242"]
```

`git` is required (the server shells out to it). `python3` is only needed for drafting code checks, which runs the drafted check's test.

```bash
docker build -t litmustest-hosted .
```

```bash
docker run -p 4242:4242 -v litmustest-data:/data --env-file hosted.env litmustest-hosted
```

## Deploy notes

- **One instance.** The clone is on local disk and saves are serialised in memory. Two instances would each hold a clone and race on the branch. Run exactly one, with a persistent volume for `/data`.
- **TLS in front.** Terminate HTTPS at a proxy or the platform and set `LITMUSTEST_PUBLIC_URL` to the `https://` address so the cookie is `Secure`. The server itself speaks plain HTTP.
- **Health check:** `GET /healthz` answers `200` without sign-in and reveals only the repository name and current branch.
- **Server-sent events:** `/api/events` is a long-lived response. Turn off response buffering for it at the proxy.
- **Secrets:** the installation token is requested as needed (valid one hour, cached until five minutes before expiry) and passed to `git` through the environment of that one command. It is never written to `.git/config` and never appears on a command line.
- **Sessions** last eight hours and live only in the cookie (signed, `HttpOnly`, `SameSite=Lax`); there is no server-side session store, so there is no way to revoke one session short of rotating `LITMUSTEST_SESSION_SECRET`. Removing someone's access on GitHub stops their writes within five minutes (the permission cache); their reads continue until the cookie expires.

## What hosted mode does not do yet

- **One branch for everyone.** All signed-in people save to the same open `evals/<slug>` branch and share one pull request. Per-person branches would need a clone or worktree per person.
- **The tray does not show the commits or the pull-request link.** `GET /api/pending` returns `hosted`, `pr`, `base` and `commits`, but the dashboard's tray still renders only the file list, and its Commit button does nothing useful (every save is already a commit). The dashboard also shows no signed-in name and no sign-out link (`/auth/logout` exists). A session that expires mid-use shows as a failed request; reload to sign in again.
- **Transcripts.** The transcript store is a git-ignored local directory, so it is not in the clone: the Transcripts page lists trials as unavailable and a judge's verdict cannot be disputed. This needs a remote transcript store.
- **Post to PR** on Run compare shells out to `gh`, which the image does not have; it answers `502` with the command.
- **Runs.** The hosted server does not run the agent. Run summaries arrive through CI commits on the base branch.
- **Preferences** (Plain language) are stored on the server, so they are shared, not per person.
- **No webhooks.** A merge is noticed at the next poll, up to 60 seconds later.

## First-deployment checklist

Nothing below has been done against real GitHub. Do each once and record the result here.

- [ ] The server starts, clones the repository and `/healthz` answers.
- [ ] `/auth/login` round-trips through github.com and `/auth/me` names you.
- [ ] A save by a person with write access appears as a commit on `evals/<slug>` with them as author, and a pull request opens.
- [ ] A person with read-only access can browse and gets `403` on save.
- [ ] A signed-out request to `/api/file` gets `401`.
- [ ] Two people editing the same lines: the second gets the reload prompt.
- [ ] Merging the pull request returns the server to the base branch within a minute.
- [ ] The base branch is protected and the App cannot push to it.
