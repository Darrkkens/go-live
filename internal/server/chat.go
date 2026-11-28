package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/Darrkkens/go-live/internal/guilds"
	"github.com/Darrkkens/go-live/internal/messages"
	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type messageEvent struct {
	Type    string           `json:"type"`
	Message messages.Message `json:"message"`
}

type presenceEvent struct {
	Type   string `json:"type"`
	UserID string `json:"userId"`
	Status string `json:"status"`
}

func (s *Server) broadcastPresence(userID, status string) {
	s.hub.emitAll(presenceEvent{Type: "presence", UserID: userID, Status: status})
}

type readEvent struct {
	Type     string    `json:"type"`
	ReaderID string    `json:"readerId"`
	ReadAt   time.Time `json:"readAt"`
}

func tokenDigest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func validContactID(c *gin.Context) (string, bool) {
	id := c.Param("contactId")
	if _, err := uuid.Parse(id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Contato não encontrado."})
		return "", false
	}
	return id, true
}

func (s *Server) listConversations(c *gin.Context) {
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	list, err := s.messages.Conversations(c.Request.Context(), u.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível carregar as conversas."})
		return
	}
	c.JSON(http.StatusOK, list)
}

func (s *Server) listMessages(c *gin.Context) {
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	contactID, ok := validContactID(c)
	if !ok {
		return
	}
	before, _ := strconv.ParseInt(c.Query("before"), 10, 64)
	limit, _ := strconv.Atoi(c.Query("limit"))
	list, err := s.messages.History(c.Request.Context(), u.ID, contactID, before, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível carregar as mensagens."})
		return
	}
	c.JSON(http.StatusOK, list)
}

func (s *Server) sendMessage(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	contactID, ok := validContactID(c)
	if !ok {
		return
	}
	var body struct {
		Body string `json:"body"`
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	m, err := s.messages.Send(c.Request.Context(), u.ID, contactID, body.Body)
	if errors.Is(err, messages.ErrInvalid) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "A mensagem precisa ter entre 1 e 4000 caracteres."})
		return
	}
	if errors.Is(err, messages.ErrRecipient) {
		c.JSON(http.StatusNotFound, gin.H{"error": "Contato não encontrado."})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível enviar a mensagem."})
		return
	}
	s.emitMessage("message", m)
	c.JSON(http.StatusCreated, m)
}

func messageID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Mensagem não encontrada."})
		return 0, false
	}
	return id, true
}

func (s *Server) editMessage(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	id, ok := messageID(c)
	if !ok {
		return
	}
	var body struct {
		Body string `json:"body"`
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	m, err := s.messages.Edit(c.Request.Context(), u.ID, id, body.Body)
	switch {
	case errors.Is(err, messages.ErrInvalid):
		c.JSON(http.StatusBadRequest, gin.H{"error": "A mensagem precisa ter entre 1 e 4000 caracteres."})
	case errors.Is(err, messages.ErrExpired):
		c.JSON(http.StatusForbidden, gin.H{"error": "O prazo de 5 minutos para editar esta mensagem terminou."})
	case errors.Is(err, messages.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "Você só pode editar mensagens suas que não foram apagadas."})
	case err != nil:
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível editar a mensagem."})
	default:
		s.emitMessage("message_updated", m)
		c.JSON(http.StatusOK, m)
	}
}

func (s *Server) deleteMessage(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	id, ok := messageID(c)
	if !ok {
		return
	}
	m, file, err := s.messages.Delete(c.Request.Context(), u.ID, id)
	// Moderators ("apagar mensagens dos outros") delete any channel message, at any time.
	if errors.Is(err, messages.ErrExpired) || errors.Is(err, messages.ErrNotFound) {
		if mod, ok := s.canModerate(c.Request.Context(), u.ID, id); ok {
			m, file, err = s.messages.DeleteAny(c.Request.Context(), mod)
		}
	}
	if errors.Is(err, messages.ErrExpired) {
		c.JSON(http.StatusForbidden, gin.H{"error": "O prazo de 5 minutos para apagar esta mensagem terminou."})
		return
	}
	if errors.Is(err, messages.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "Você só pode apagar mensagens suas."})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível apagar a mensagem."})
		return
	}
	if file != "" {
		_ = os.Remove(filepath.Join(attachmentDir(), filepath.Base(file)))
	}
	s.emitMessage("message_updated", m)
	c.JSON(http.StatusOK, m)
}

func (s *Server) markRead(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	contactID, ok := validContactID(c)
	if !ok {
		return
	}
	readAt, changed, err := s.messages.MarkRead(c.Request.Context(), u.ID, contactID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível atualizar a conversa."})
		return
	}
	if changed > 0 {
		s.hub.emit(readEvent{Type: "read", ReaderID: u.ID, ReadAt: readAt}, contactID)
	}
	c.Status(http.StatusNoContent)
}

func frontendOrigin() string {
	if origin := os.Getenv("FRONTEND_ORIGIN"); origin != "" {
		return origin
	}
	return "http://localhost:5173"
}

// realtime upgrades an authenticated request to a WebSocket that receives chat events.
func (s *Server) realtime(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	token, _ := c.Cookie(sessionCookie)
	allowed, err := url.Parse(frontendOrigin())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Origem inválida."})
		return
	}
	// The HTTP server's read/write timeouts would otherwise end long-lived sockets.
	rc := http.NewResponseController(c.Writer)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})
	conn, err := websocket.Accept(c.Writer, c.Request, &websocket.AcceptOptions{OriginPatterns: []string{allowed.Host}})
	if err != nil {
		log.Printf("could not open websocket: %v", err)
		return
	}
	conn.SetReadLimit(4 << 10)
	defer conn.CloseNow()

	cl := &client{userID: u.ID, tokenHash: tokenDigest(token), send: make(chan []byte, 64), done: make(chan struct{})}
	if s.hub.add(cl) {
		s.broadcastPresence(u.ID, u.Status)
	}
	defer func() {
		if s.hub.remove(cl) {
			s.broadcastPresence(u.ID, "offline")
			s.userWentOffline(u.ID)
		}
	}()

	ctx := conn.CloseRead(context.Background())
	sessionCheck := time.NewTicker(time.Minute)
	defer sessionCheck.Stop()
	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-cl.done:
			conn.Close(websocket.StatusPolicyViolation, "session closed")
			return
		case payload := <-cl.send:
			writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Write(writeCtx, websocket.MessageText, payload)
			cancel()
			if err != nil {
				return
			}
		case <-ping.C:
			pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}
		case <-sessionCheck.C:
			checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			_, err := s.accounts.Session(checkCtx, token)
			cancel()
			if err != nil {
				conn.Close(websocket.StatusPolicyViolation, "session expired")
				return
			}
		}
	}
}

// canModerate reports whether the user may delete someone else's channel message.
func (s *Server) canModerate(ctx context.Context, userID string, messageID int64) (int64, bool) {
	m, err := s.messages.Get(ctx, messageID)
	if err != nil || m.ChannelID == "" || m.DeletedAt != nil || m.Call != nil {
		return 0, false
	}
	ch, err := s.guilds.Channel(ctx, m.ChannelID)
	if err != nil {
		return 0, false
	}
	a, err := s.guilds.Access(ctx, ch.GuildID, userID)
	return m.ID, err == nil && a.Can(ch.ID, guilds.PermManageMessages)
}
