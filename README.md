# go-live

Go Blueprint starter with Gin, Postgres, a React/TypeScript frontend, and a WebSocket endpoint.

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

Start Postgres with `docker compose up -d`, then run the API and frontend in separate terminals:

```sh
go run ./cmd/api
```

```sh
cd frontend
npm install
npm run dev
```

The API listens on `http://localhost:8081`; Vite serves the frontend on `http://localhost:5173`. The scaffold provides `GET /`, `GET /health`, and `GET /websocket`.

## Verify

```sh
go test ./...
cd frontend && npm run build
```

The Go test suite starts a Postgres container, so Docker must be running.
