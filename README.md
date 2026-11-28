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

Start Postgres and LiveKit with `docker compose up -d`. Calls need `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` (at least 32 characters, e.g. `openssl rand -hex 32`) in `.env`; without them the rest of the app works and calls are disabled. Set `LIVEKIT_NODE_IP` to this machine's LAN IP (not `127.0.0.1`: Firefox ignores loopback addresses in WebRTC and the call never connects) and update it if that IP changes. To test calls from another device on the network, also set `LIVEKIT_URL` to that IP; browsers only allow the microphone and camera on `localhost` or HTTPS, so other devices need HTTPS. In production, serve LiveKit behind TLS (`wss://`) and enable its TURN server so calls connect from restrictive networks. Create the first admin master in a terminal (the password is entered without echo):

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

After login, the chat screen lists active users as contacts, ordered by the most recent conversation, with the last message preview and an unread count. Selecting a contact opens a one-to-one text conversation: messages are stored in Postgres (`direct_messages`), up to 4000 characters each, and load 50 at a time with a button for older ones. Enter sends and Shift+Enter adds a line break. New messages and read receipts (✓ sent, ✓✓ read) arrive in real time over an authenticated WebSocket at `/api/ws`; the browser reconnects automatically and reloads conversations after a reconnect. Logging out, changing the password, or being blocked closes that user's WebSocket. Presence also updates in real time: a contact shows their chosen status (online, away, busy) while they have the app open and appears offline when their last tab closes; choosing `offline` hides them. Images and files can be sent by choosing a file (paperclip button), pasting with Ctrl+V, or dragging onto the conversation; a preview with an optional caption appears before sending (Enter sends, Esc cancels) and the upload shows progress. Images: PNG, JPEG, WebP and GIF up to 10 MB and 40 megapixels. Files up to 25 MB from an allowlist: PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, ODT/ODS/ODP, TXT, CSV, MD, ZIP, RAR and 7z; the server checks the content matches the extension, so other types (executables, HTML, SVG) are rejected. Files are kept with their original name; PDFs open in a new tab and other files download. Still images are re-encoded, which removes metadata such as GPS location, and scaled to at most 2560 px; GIFs are kept as sent so animations work. Files are stored in `ATTACHMENT_DIR` (default `data/attachments`, keep it persistent) and are served only to the two people in the conversation. Clicking an image opens it full screen with a download button. Hovering a message shows a menu (also on right-click): your own messages can be edited (text or caption, marked "editada") or deleted for everyone after a confirmation during the first 5 minutes after sending (enforced by the server using the database clock; the menu shows the time left); any message's text can be copied. Arrow Up in an empty composer edits your last message. A deleted message is replaced by "Mensagem apagada" for both people, its attachment file is removed from disk, and it no longer counts as unread. One-to-one voice and video calls with screen sharing run on a self-hosted [LiveKit](https://livekit.io) server (the `livekit` service in `docker-compose.yml`). The Go API issues short-lived room tokens and manages the call: it rings every open tab of the contact for 30 seconds, records the call in the conversation (duration, declined, missed or cancelled), turns calls to offline, invisible or busy contacts into a missed call, and ends a call 15 seconds after a participant closes the app. During a call you can mute, turn the camera on or off and share your screen; a reloaded page resumes the call. Group calls are an upcoming stage.

Servers work like Discord: any user can create one (with an optional PNG/JPEG image) and becomes its owner. The left rail lists direct messages and your servers; each server has text channels (`#geral` by default), a member list grouped by presence, and the same chat features as direct messages (attachments, edit/delete within 5 minutes, unread counts per channel). Owners and admins create, rename and delete channels, invite people with links (`/convite/CODE`, with expiry and use limits) or add users directly, and remove regular members; only the owner renames or deletes the server, changes its image and promotes admins. Invites only work for people who already have an account.

Voice channels work like Discord's: clicking one joins it (no ringing), and everyone in the server sees who is connected under the channel, with muted, deafened, camera and "AO VIVO" (screen share) indicators. Inside, participants appear as a grid of tiles (camera or avatar, a green outline while speaking); a screen share takes focus. Controls: camera, screen share, microphone, deafen (mutes everyone's audio and your microphone) and disconnect. Browsing elsewhere keeps you connected, with a "Voz conectada" card in the sidebar. Joining another voice channel moves you there; you can't be in a voice channel and a one-to-one call at the same time. Up to 25 people per channel. People are disconnected when they leave or are removed from the server, when the channel or server is deleted, or 15 seconds after closing the app.

The interface has light and dark themes ("Meu perfil → Aparência"); the default follows the system setting. The layout uses the provided Chatgram Figma UI kit as a visual reference.

Text chat API (session cookie required; `POST` requests must come from `FRONTEND_ORIGIN`):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/conversations` | Last message and unread count per contact |
| `GET` | `/api/conversations/:contactId/messages?before=ID&limit=50` | History, oldest first |
| `POST` | `/api/conversations/:contactId/messages` | Send `{ "body": "..." }` |
| `POST` | `/api/conversations/:contactId/read` | Mark the contact's messages as read |
| `POST` | `/api/conversations/:contactId/attachments` | Send multipart `file` (image or document) with optional `caption` |
| `GET` | `/api/messages/:id/attachment` | Attachment of a message you sent or received (`?download=1` to download) |
| `PATCH` | `/api/messages/:id` | Edit your message `{ "body": "..." }` |
| `DELETE` | `/api/messages/:id` | Delete your message for everyone |
| `POST` | `/api/calls` | Start a call `{ "contactId": "...", "media": "audio" \| "video" }` |
| `POST` | `/api/calls/:id/accept` · `/decline` · `/end` | Answer, decline or hang up |
| `GET` | `/api/calls/current` | Your ringing or active call (to resume after a reload) |
| `GET` · `POST` | `/api/guilds` | Your servers · create a server `{ "name": "..." }` |
| `GET` · `PATCH` · `DELETE` | `/api/guilds/:id` | Server with channels, members and unread counts · rename · delete |
| `POST` · `DELETE` | `/api/guilds/:id/icon` | Set (multipart `icon`) or remove the server image |
| `POST` | `/api/guilds/:id/leave` · `/members` · `/channels` · `/invites` | Leave · add a user · create a channel · create an invite link |
| `PATCH` · `DELETE` | `/api/guilds/:id/members/:userId` | Change role (`admin`/`member`) · remove a member |
| `GET` · `POST` | `/api/channels/:channelId/messages` | Channel history · send |
| `POST` | `/api/channels/:channelId/attachments` · `/read` | Send a file · mark as read |
| `GET` · `POST` | `/api/invites/:code` · `/api/invites/:code/accept` | Preview · join |
| `POST` | `/api/channels/:channelId/voice/join` | Join a voice channel (returns a LiveKit token) |
| `POST` | `/api/voice/leave` · `/api/voice/state` | Leave · report `{ muted, deafened, video, screen }` |
| `GET` | `/api/voice/current` | Your voice channel (to rejoin after a reload) |
| `GET` | `/api/ws` | WebSocket with `message`, `message_updated`, `read`, `presence`, `call`, `guild` and `voice` events |

## Verify

```sh
go test ./...
cd frontend && npm run build
```

The Go test suite starts a Postgres container, so Docker must be running.
