package server

import "testing"

func TestHubEmitAndDisconnect(t *testing.T) {
	h := newHub()
	a1 := &client{userID: "a", tokenHash: "t1", send: make(chan []byte, 1), done: make(chan struct{})}
	a2 := &client{userID: "a", tokenHash: "t2", send: make(chan []byte, 1), done: make(chan struct{})}
	b := &client{userID: "b", tokenHash: "t3", send: make(chan []byte, 1), done: make(chan struct{})}
	if !h.add(a1) || h.add(a2) || !h.add(b) {
		t.Fatal("first-connection flag wrong")
	}
	if !h.online("a") || h.online("c") {
		t.Fatal("online flag wrong")
	}

	h.emit(map[string]string{"type": "x"}, "a", "a")
	if len(a1.send) != 1 || len(a2.send) != 1 || len(b.send) != 0 {
		t.Fatal("emit did not reach exactly user a once per connection")
	}
	h.emit(map[string]string{"type": "y"}, "a")
	select {
	case <-a1.done:
	default:
		t.Fatal("slow client was not closed")
	}

	h.disconnect("b", "other")
	select {
	case <-b.done:
		t.Fatal("wrong session disconnected")
	default:
	}
	h.disconnect("b", "t3")
	<-b.done
	if !h.remove(b) || h.remove(b) {
		t.Fatal("last-connection flag wrong")
	}
	if _, ok := h.clients["b"]; ok || h.online("b") {
		t.Fatal("empty user entry kept")
	}
	if h.remove(a1) || !h.remove(a2) {
		t.Fatal("last connection of a not detected")
	}
}
