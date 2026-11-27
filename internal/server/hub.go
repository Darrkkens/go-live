package server

import (
	"encoding/json"
	"sync"
)

// hub keeps the open realtime connections of each user.
type hub struct {
	mu      sync.Mutex
	clients map[string]map[*client]struct{}
}

type client struct {
	userID    string
	tokenHash string
	send      chan []byte
	done      chan struct{}
	closeOnce sync.Once
}

func (c *client) close() { c.closeOnce.Do(func() { close(c.done) }) }

func newHub() *hub { return &hub{clients: map[string]map[*client]struct{}{}} }

// add registers a connection and reports whether it is the user's first.
func (h *hub) add(c *client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	first := len(h.clients[c.userID]) == 0
	if first {
		h.clients[c.userID] = map[*client]struct{}{}
	}
	h.clients[c.userID][c] = struct{}{}
	return first
}

// remove unregisters a connection and reports whether it was the user's last.
func (h *hub) remove(c *client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[c.userID][c]; !ok {
		return false
	}
	delete(h.clients[c.userID], c)
	if len(h.clients[c.userID]) == 0 {
		delete(h.clients, c.userID)
		return true
	}
	return false
}

func (h *hub) online(userID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients[userID]) > 0
}

// emitAll sends an event to every open connection.
func (h *hub) emitAll(event any) {
	h.mu.Lock()
	ids := make([]string, 0, len(h.clients))
	for id := range h.clients {
		ids = append(ids, id)
	}
	h.mu.Unlock()
	h.emit(event, ids...)
}

// emit sends an event to every connection of the given users. A connection
// that cannot keep up is closed; the client reloads state when it reconnects.
func (h *hub) emit(event any, userIDs ...string) {
	payload, err := json.Marshal(event)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	seen := map[string]bool{}
	for _, id := range userIDs {
		if seen[id] {
			continue
		}
		seen[id] = true
		for c := range h.clients[id] {
			select {
			case c.send <- payload:
			default:
				c.close()
			}
		}
	}
}

// disconnect closes the user's connections; with a token hash, only that session's.
func (h *hub) disconnect(userID, tokenHash string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients[userID] {
		if tokenHash == "" || c.tokenHash == tokenHash {
			c.close()
		}
	}
}
