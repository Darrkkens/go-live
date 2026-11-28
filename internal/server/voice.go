package server

import (
	"context"
	"log"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const maxVoiceMembers = 25

// voiceMember is someone connected to a voice channel, as everyone in the server sees it.
type voiceMember struct {
	UserID   string    `json:"userId"`
	Muted    bool      `json:"muted"`
	Deafened bool      `json:"deafened"`
	Video    bool      `json:"video"`
	Screen   bool      `json:"screen"`
	JoinedAt time.Time `json:"joinedAt"`
}

type voiceChannel struct {
	guildID string
	members map[string]*voiceMember
}

// voiceManager tracks who is in which voice channel. A user is in at most one.
type voiceManager struct {
	mu       sync.Mutex
	channels map[string]*voiceChannel
	byUser   map[string]string
}

func newVoiceManager() *voiceManager {
	return &voiceManager{channels: map[string]*voiceChannel{}, byUser: map[string]string{}}
}

func voiceRoom(channelID string) string { return "voice-" + channelID }

// listLocked returns a channel's members in join order. The caller holds mu.
func (v *voiceManager) listLocked(channelID string) []voiceMember {
	ch := v.channels[channelID]
	list := []voiceMember{}
	if ch == nil {
		return list
	}
	for _, m := range ch.members {
		list = append(list, *m)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].JoinedAt.Before(list[j].JoinedAt) })
	return list
}

// forGuild returns the members of every active voice channel of a server.
func (v *voiceManager) forGuild(guildID string) map[string][]voiceMember {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := map[string][]voiceMember{}
	for id, ch := range v.channels {
		if ch.guildID == guildID {
			out[id] = v.listLocked(id)
		}
	}
	return out
}

func (v *voiceManager) channelOf(userID string) string {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.byUser[userID]
}

// join moves the user into channelID and returns the channel they left, if any.
func (v *voiceManager) join(guildID, channelID, userID string) (string, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	previous := v.byUser[userID]
	if previous == channelID {
		return "", true
	}
	ch := v.channels[channelID]
	if ch != nil && len(ch.members) >= maxVoiceMembers {
		return "", false
	}
	if previous != "" {
		v.removeLocked(previous, userID)
	}
	if ch == nil {
		ch = &voiceChannel{guildID: guildID, members: map[string]*voiceMember{}}
		v.channels[channelID] = ch
	}
	ch.members[userID] = &voiceMember{UserID: userID, JoinedAt: time.Now().UTC()}
	v.byUser[userID] = channelID
	return previous, true
}

func (v *voiceManager) removeLocked(channelID, userID string) {
	if ch := v.channels[channelID]; ch != nil {
		delete(ch.members, userID)
		if len(ch.members) == 0 {
			delete(v.channels, channelID)
		}
	}
	if v.byUser[userID] == channelID {
		delete(v.byUser, userID)
	}
}

// leave removes the user from their voice channel and returns it ("" if none).
func (v *voiceManager) leave(userID string) (string, string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	channelID := v.byUser[userID]
	if channelID == "" {
		return "", ""
	}
	guildID := v.channels[channelID].guildID
	v.removeLocked(channelID, userID)
	return channelID, guildID
}

// clearChannel removes everyone from a channel and returns who was there.
func (v *voiceManager) clearChannel(channelID string) []string {
	v.mu.Lock()
	defer v.mu.Unlock()
	ch := v.channels[channelID]
	if ch == nil {
		return nil
	}
	ids := make([]string, 0, len(ch.members))
	for id := range ch.members {
		ids = append(ids, id)
		delete(v.byUser, id)
	}
	delete(v.channels, channelID)
	return ids
}

func (v *voiceManager) setState(userID string, muted, deafened, video, screen bool) (string, string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	channelID := v.byUser[userID]
	ch := v.channels[channelID]
	if ch == nil || ch.members[userID] == nil {
		return "", ""
	}
	m := ch.members[userID]
	m.Muted, m.Deafened, m.Video, m.Screen = muted, deafened, video, screen
	return channelID, ch.guildID
}

type voiceEvent struct {
	Type      string        `json:"type"`
	GuildID   string        `json:"guildId"`
	ChannelID string        `json:"channelId"`
	Members   []voiceMember `json:"members"`
}

// emitVoice tells a server's members who is in one of its voice channels.
func (s *Server) emitVoice(guildID, channelID string) {
	if guildID == "" || channelID == "" {
		return
	}
	s.voice.mu.Lock()
	members := s.voice.listLocked(channelID)
	s.voice.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ids, _ := s.guilds.MemberIDs(ctx, guildID)
	s.hub.emit(voiceEvent{Type: "voice", GuildID: guildID, ChannelID: channelID, Members: members}, ids...)
}

// disconnectVoice removes users from a LiveKit voice room in the background.
func (s *Server) disconnectVoice(channelID string, userIDs ...string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		for _, id := range userIDs {
			if err := s.livekit.RemoveParticipant(ctx, voiceRoom(channelID), id); err != nil {
				log.Printf("voice %s: remove %s: %v", channelID, id, err)
			}
		}
	}()
}

// leaveVoice takes the user out of voice (if connected) and tells the server.
func (s *Server) leaveVoice(userID string, kick bool) {
	channelID, guildID := s.voice.leave(userID)
	if channelID == "" {
		return
	}
	if kick {
		s.disconnectVoice(channelID, userID)
	}
	s.emitVoice(guildID, channelID)
}

// leaveVoiceInGuild disconnects the user if they are in one of the server's voice channels.
func (s *Server) leaveVoiceInGuild(userID, guildID string) {
	s.voice.mu.Lock()
	channelID := s.voice.byUser[userID]
	inGuild := channelID != "" && s.voice.channels[channelID].guildID == guildID
	s.voice.mu.Unlock()
	if inGuild {
		s.leaveVoice(userID, true)
	}
}

// closeVoiceChannel disconnects everyone from a deleted channel.
func (s *Server) closeVoiceChannel(guildID, channelID string) {
	ids := s.voice.clearChannel(channelID)
	if len(ids) == 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.livekit.DeleteRoom(ctx, voiceRoom(channelID))
	}()
	s.hub.emit(voiceEvent{Type: "voice", GuildID: guildID, ChannelID: channelID, Members: []voiceMember{}}, ids...)
	s.emitVoice(guildID, channelID)
}

func (s *Server) joinVoice(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	ch, _, ok := s.channelForMember(c, u.ID)
	if !ok {
		return
	}
	if ch.Kind != "voice" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Este não é um canal de voz."})
		return
	}
	if !s.livekit.Enabled() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "As chamadas não estão configuradas neste servidor."})
		return
	}
	s.calls.mu.Lock()
	inCall := s.calls.forUser(u.ID) != nil
	s.calls.mu.Unlock()
	if inCall {
		c.JSON(http.StatusConflict, gin.H{"error": "Encerre a ligação atual antes de entrar em um canal de voz."})
		return
	}
	token, err := s.livekit.JoinToken(voiceRoom(ch.ID), u.ID, u.Username, callTokenTTL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível entrar no canal de voz."})
		return
	}
	previous, ok := s.voice.join(ch.GuildID, ch.ID, u.ID)
	if !ok {
		c.JSON(http.StatusConflict, gin.H{"error": "Este canal de voz está cheio."})
		return
	}
	if previous != "" {
		// Like Discord, joining another channel moves you there.
		s.disconnectVoice(previous, u.ID)
		if prev, err := s.guilds.Channel(c.Request.Context(), previous); err == nil {
			s.emitVoice(prev.GuildID, previous)
		}
	}
	s.emitVoice(ch.GuildID, ch.ID)
	c.JSON(http.StatusOK, gin.H{"channelId": ch.ID, "guildId": ch.GuildID, "url": s.livekit.URL, "token": token})
}

func (s *Server) leaveVoiceHandler(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	s.leaveVoice(u.ID, false)
	c.Status(http.StatusNoContent)
}

func (s *Server) voiceState(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	var body struct {
		Muted    bool `json:"muted"`
		Deafened bool `json:"deafened"`
		Video    bool `json:"video"`
		Screen   bool `json:"screen"`
	}
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	channelID, guildID := s.voice.setState(u.ID, body.Muted, body.Deafened, body.Video, body.Screen)
	if channelID == "" {
		c.JSON(http.StatusConflict, gin.H{"error": "Você não está em um canal de voz."})
		return
	}
	s.emitVoice(guildID, channelID)
	c.Status(http.StatusNoContent)
}

// currentVoice lets a reloaded page rejoin its voice channel.
func (s *Server) currentVoice(c *gin.Context) {
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	channelID := s.voice.channelOf(u.ID)
	if channelID == "" {
		c.JSON(http.StatusOK, gin.H{"channelId": nil})
		return
	}
	ch, err := s.guilds.Channel(c.Request.Context(), channelID)
	if err != nil {
		s.leaveVoice(u.ID, true)
		c.JSON(http.StatusOK, gin.H{"channelId": nil})
		return
	}
	token, err := s.livekit.JoinToken(voiceRoom(ch.ID), u.ID, u.Username, callTokenTTL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível retomar o canal de voz."})
		return
	}
	c.JSON(http.StatusOK, gin.H{"channelId": ch.ID, "guildId": ch.GuildID, "url": s.livekit.URL, "token": token})
}
