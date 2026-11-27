# go-live

Go + Gin + Postgres + React/TypeScript application for text and voice chat. The first implemented stage covers accounts and access; chat and calls are upcoming stages.

## Requirements

- Go 1.27.1 or newer
- Node.js 22.12 or newer and npm
- Docker for the Postgres container and database integration tests

## Run locally

Copy the example environment files:

```sh
cp .env.example .env
cp frontend/.env.example frontend/.env
```

Start Postgres with `docker compose up -d`. Create the first admin master in a terminal (the password is entered without echo):

```sh
go run ./cmd/create-master
```

This command can create only one master. Then run the API and frontend in separate terminals:

```sh
go run ./cmd/api
```

```sh
cd frontend
npm install
npm run dev
```

If a local administrator needs to reset an account password, run `go run ./cmd/reset-password -tag USER_TAG`. The command reads the new password without echo and ends existing sessions.

The API listens on `http://localhost:8081`; Vite serves the frontend on `http://localhost:5173`. Set `FRONTEND_ORIGIN` if the frontend has a different origin. In production, set `APP_ENV=production` and serve the API over HTTPS so session cookies use `Secure`.

The master signs in with email or `@userTag` and creates user accounts. Users can upload an avatar by dragging an image or choosing a file, and can update their presence status and password. Avatars accept PNG or JPEG up to 4 MB and 2048 × 2048 pixels. Files are stored in `AVATAR_DIR` (default `data/avatars`); keep this directory persistent when deploying. Account access status (`active` or `blocked`) is managed by the master. Passwords are stored as Argon2id hashes; session tokens are stored as SHA-256 digests in Postgres. There is no public registration.

## Verify

```sh
go test ./...
cd frontend && npm run build
```

The Go test suite starts a Postgres container, so Docker must be running.
