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

func TestEndStatus(t *testing.T) {
	ringing := &activeCall{callInfo: callInfo{CallerID: "a", CalleeID: "b", Status: "ringing"}}
	active := &activeCall{callInfo: callInfo{CallerID: "a", CalleeID: "b", Status: "active"}}
	if endStatus(ringing, "a") != "cancelled" || endStatus(ringing, "b") != "declined" || endStatus(active, "a") != "ended" || endStatus(active, "b") != "ended" {
		t.Fatal("unexpected end status")
	}
}

func TestVoiceManager(t *testing.T) {
	v := newVoiceManager()
	if prev, ok := v.join("g", "c1", "a"); !ok || prev != "" {
		t.Fatal("first join")
	}
	v.join("g", "c1", "b")
	if prev, ok := v.join("g", "c2", "a"); !ok || prev != "c1" {
		t.Fatalf("move: %q", prev)
	}
	if got := v.forGuild("g"); len(got["c1"]) != 1 || len(got["c2"]) != 1 || got["c1"][0].UserID != "b" {
		t.Fatalf("state after move: %+v", got)
	}
	if ch, _ := v.setState("a", true, true, false, true); ch != "c2" {
		t.Fatal("set state")
	}
	if m := v.forGuild("g")["c2"][0]; !m.Muted || !m.Deafened || !m.Screen {
		t.Fatalf("state not saved: %+v", m)
	}
	if ch, g := v.leave("a"); ch != "c2" || g != "g" || v.channelOf("a") != "" {
		t.Fatal("leave")
	}
	if _, ok := v.forGuild("g")["c2"]; ok {
		t.Fatal("empty channel kept")
	}
	if ids := v.clearChannel("c1"); len(ids) != 1 || v.channelOf("b") != "" {
		t.Fatalf("clear: %v", ids)
	}
	for i := 0; i < maxVoiceMembers; i++ {
		v.join("g", "full", string(rune('A'+i)))
	}
	if _, ok := v.join("g", "full", "late"); ok {
		t.Fatal("joined a full channel")
	}
}
