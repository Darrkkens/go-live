package server

import (
	"context"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/Darrkkens/go-live/internal/messages"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const ringTimeout = 30 * time.Second
const offlineGrace = 15 * time.Second
const callTokenTTL = 10 * time.Minute

// callInfo is what clients see of a call.
type callInfo struct {
	ID         string     `json:"id"`
	CallerID   string     `json:"callerId"`
	CalleeID   string     `json:"calleeId"`
	Media      string     `json:"media"`
	Status     string     `json:"status"`
	StartedAt  time.Time  `json:"startedAt"`
	AnsweredAt *time.Time `json:"answeredAt"`
}

type callEvent struct {
	Type string   `json:"type"`
	Call callInfo `json:"call"`
}

type activeCall struct {
	callInfo
	room  string
	timer *time.Timer
}

// callManager keeps live calls in memory; the history lives in messages.
type callManager struct {
	mu     sync.Mutex
	calls  map[string]*activeCall
	byUser map[string]string
}

func newCallManager() *callManager {
	return &callManager{calls: map[string]*activeCall{}, byUser: map[string]string{}}
}

func (m *callManager) forUser(userID string) *activeCall {
	if id, ok := m.byUser[userID]; ok {
		return m.calls[id]
	}
	return nil
}

func (c *activeCall) other(userID string) string {
	if c.CallerID == userID {
		return c.CalleeID
	}
	return c.CallerID
}

type callJoin struct {
	Call  callInfo `json:"call"`
	URL   string   `json:"url,omitempty"`
	Token string   `json:"token,omitempty"`
}

func (s *Server) joinInfo(c *activeCall, userID, name string) (callJoin, error) {
	token, err := s.livekit.JoinToken(c.room, userID, name, callTokenTTL)
	return callJoin{Call: c.callInfo, URL: s.livekit.URL, Token: token}, err
}

func (s *Server) emitCall(c callInfo) {
	s.hub.emit(callEvent{Type: "call", Call: c}, c.CallerID, c.CalleeID)
}

func (s *Server) emitMessageUpdate(m messages.Message) {
	s.hub.emit(messageEvent{Type: "message_updated", Message: m}, m.SenderID, m.RecipientID)
}

// finishLocked ends a live call with a final status. The caller holds s.calls.mu.
func (s *Server) finishLocked(c *activeCall, status string) {
	if c.timer != nil {
		c.timer.Stop()
	}
	delete(s.calls.calls, c.ID)
	if s.calls.byUser[c.CallerID] == c.ID {
		delete(s.calls.byUser, c.CallerID)
	}
	if s.calls.byUser[c.CalleeID] == c.ID {
		delete(s.calls.byUser, c.CalleeID)
	}
	duration := 0
	if c.AnsweredAt != nil {
		duration = int(time.Since(*c.AnsweredAt).Round(time.Second) / time.Second)
	}
	c.Status = status
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if m, err := s.messages.UpdateCall(ctx, c.ID, status, duration); err == nil {
		s.emitMessageUpdate(m)
	} else {
		log.Printf("call %s: could not record end: %v", c.ID, err)
	}
	s.emitCall(c.callInfo)
	room := c.room
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.livekit.DeleteRoom(ctx, room); err != nil {
			log.Printf("call room %s: %v", room, err)
		}
	}()
}

func (s *Server) startCall(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	if !s.livekit.Enabled() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "As chamadas não estão configuradas neste servidor."})
		return
	}
	var body struct {
		ContactID string `json:"contactId"`
		Media     string `json:"media"`
	}
	if c.ShouldBindJSON(&body) != nil || (body.Media != "audio" && body.Media != "video") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	if _, err := uuid.Parse(body.ContactID); err != nil || body.ContactID == u.ID {
		c.JSON(http.StatusNotFound, gin.H{"error": "Contato não encontrado."})
		return
	}
	contact, err := s.accounts.Contact(c.Request.Context(), body.ContactID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Contato não encontrado."})
		return
	}

	s.calls.mu.Lock()
	defer s.calls.mu.Unlock()
	if s.calls.forUser(u.ID) != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "Você já está em uma ligação."})
		return
	}
	if s.voice.channelOf(u.ID) != "" {
		c.JSON(http.StatusConflict, gin.H{"error": "Saia do canal de voz antes de ligar."})
		return
	}
	call := &activeCall{callInfo: callInfo{ID: uuid.NewString(), CallerID: u.ID, CalleeID: contact.ID, Media: body.Media, Status: messages.CallRinging, StartedAt: time.Now().UTC()}}
	call.room = "call-" + call.ID

	// Offline, invisible or busy contacts get a missed call instead of ringing.
	unavailable := ""
	switch {
	case !s.hub.online(contact.ID) || contact.Status == "offline":
		unavailable = "offline"
	case s.calls.forUser(contact.ID) != nil || s.voice.channelOf(contact.ID) != "":
		unavailable = "busy"
	}
	status := messages.CallRinging
	if unavailable != "" {
		status = messages.CallMissed
	}
	m, err := s.messages.StartCall(c.Request.Context(), u.ID, contact.ID, call.ID, body.Media, status)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível iniciar a ligação."})
		return
	}
	s.hub.emit(messageEvent{Type: "message", Message: m}, u.ID, contact.ID)
	if unavailable != "" {
		call.Status = messages.CallMissed
		msg := contact.Username + " não está disponível agora. Ficou registrada uma chamada perdida."
		if unavailable == "busy" {
			msg = contact.Username + " está em outra ligação. Ficou registrada uma chamada perdida."
		}
		c.JSON(http.StatusOK, gin.H{"call": call.callInfo, "unavailable": unavailable, "message": msg})
		return
	}

	join, err := s.joinInfo(call, u.ID, u.Username)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível iniciar a ligação."})
		return
	}
	s.calls.calls[call.ID] = call
	s.calls.byUser[u.ID] = call.ID
	s.calls.byUser[contact.ID] = call.ID
	id := call.ID
	call.timer = time.AfterFunc(ringTimeout, func() {
		s.calls.mu.Lock()
		defer s.calls.mu.Unlock()
		if current := s.calls.calls[id]; current != nil && current.Status == messages.CallRinging {
			s.finishLocked(current, messages.CallMissed)
		}
	})
	s.emitCall(call.callInfo)
	c.JSON(http.StatusCreated, join)
}

// callAction loads the user's live call matching the URL id.
func (s *Server) callAction(c *gin.Context) (*activeCall, string, string, bool) {
	if !s.sameOrigin(c) {
		return nil, "", "", false
	}
	u, ok := s.currentUser(c)
	if !ok {
		return nil, "", "", false
	}
	call := s.calls.calls[c.Param("id")]
	if call == nil || (call.CallerID != u.ID && call.CalleeID != u.ID) {
		c.JSON(http.StatusNotFound, gin.H{"error": "Esta ligação já terminou."})
		return nil, "", "", false
	}
	return call, u.ID, u.Username, true
}

func (s *Server) acceptCall(c *gin.Context) {
	s.calls.mu.Lock()
	defer s.calls.mu.Unlock()
	call, userID, name, ok := s.callAction(c)
	if !ok {
		return
	}
	if call.CalleeID != userID || call.Status != messages.CallRinging {
		c.JSON(http.StatusConflict, gin.H{"error": "Esta ligação não pode mais ser atendida."})
		return
	}
	join, err := s.joinInfo(call, userID, name)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível atender."})
		return
	}
	call.timer.Stop()
	now := time.Now().UTC()
	call.Status, call.AnsweredAt = messages.CallActive, &now
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	if m, err := s.messages.UpdateCall(ctx, call.ID, messages.CallActive, 0); err == nil {
		s.emitMessageUpdate(m)
	}
	s.emitCall(call.callInfo)
	join.Call = call.callInfo
	c.JSON(http.StatusOK, join)
}

func (s *Server) declineCall(c *gin.Context) {
	s.calls.mu.Lock()
	defer s.calls.mu.Unlock()
	call, userID, _, ok := s.callAction(c)
	if !ok {
		return
	}
	if call.CalleeID != userID || call.Status != messages.CallRinging {
		c.JSON(http.StatusConflict, gin.H{"error": "Esta ligação não está mais tocando."})
		return
	}
	s.finishLocked(call, messages.CallDeclined)
	c.Status(http.StatusNoContent)
}

func (s *Server) endCall(c *gin.Context) {
	s.calls.mu.Lock()
	defer s.calls.mu.Unlock()
	call, userID, _, ok := s.callAction(c)
	if !ok {
		return
	}
	s.finishLocked(call, endStatus(call, userID))
	c.Status(http.StatusNoContent)
}

// endStatus is the final status when userID leaves the call.
func endStatus(call *activeCall, userID string) string {
	switch {
	case call.Status == messages.CallActive:
		return messages.CallEnded
	case userID == call.CallerID:
		return messages.CallCancelled
	default:
		return messages.CallDeclined
	}
}

// currentCall lets a reloaded page resume its ringing or active call.
func (s *Server) currentCall(c *gin.Context) {
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	s.calls.mu.Lock()
	defer s.calls.mu.Unlock()
	call := s.calls.forUser(u.ID)
	if call == nil {
		c.JSON(http.StatusOK, gin.H{"call": nil})
		return
	}
	// The callee only receives a token after accepting.
	if call.Status == messages.CallRinging && call.CalleeID == u.ID {
		c.JSON(http.StatusOK, callJoin{Call: call.callInfo})
		return
	}
	join, err := s.joinInfo(call, u.ID, u.Username)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível retomar a ligação."})
		return
	}
	c.JSON(http.StatusOK, join)
}

// userWentOffline ends the user's call if they do not come back shortly,
// e.g. after closing the last tab or losing the connection.
func (s *Server) userWentOffline(userID string) {
	time.AfterFunc(offlineGrace, func() {
		if s.hub.online(userID) {
			return
		}
		s.leaveVoice(userID, true)
		s.calls.mu.Lock()
		defer s.calls.mu.Unlock()
		call := s.calls.forUser(userID)
		if call == nil {
			return
		}
		// A ringing call to an offline callee runs out on its own timer.
		if call.Status == messages.CallRinging && call.CalleeID == userID {
			return
		}
		s.finishLocked(call, endStatus(call, userID))
	})
}
