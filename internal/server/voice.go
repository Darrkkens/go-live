package server

import (
	"context"
	"log"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/Darrkkens/go-live/internal/guilds"
	"github.com/Darrkkens/go-live/internal/livekit"
	"github.com/gin-gonic/gin"
)

const maxVoiceMembers = 25

// voiceMember is someone connected to a voice channel, as everyone in the server sees it.
type voiceMember struct {
	UserID   string `json:"userId"`
	Muted    bool   `json:"muted"`
	Deafened bool   `json:"deafened"`
	Video    bool   `json:"video"`
	Screen   bool   `json:"screen"`
	// ServerMuted is set by a moderator; the member cannot unmute until it is lifted.
	ServerMuted bool      `json:"serverMuted"`
	JoinedAt    time.Time `json:"joinedAt"`
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
	// serverMuted[guildID][userID]: a server mute follows the member across that server's channels.
	serverMuted map[string]map[string]bool
}

func newVoiceManager() *voiceManager {
	return &voiceManager{channels: map[string]*voiceChannel{}, byUser: map[string]string{}, serverMuted: map[string]map[string]bool{}}
}

func (v *voiceManager) isServerMuted(guildID, userID string) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.serverMuted[guildID][userID]
}

// setServerMute records a moderator mute and returns the member's current channel in that server.
func (v *voiceManager) setServerMute(guildID, userID string, muted bool) string {
	v.mu.Lock()
	defer v.mu.Unlock()
	if muted {
		if v.serverMuted[guildID] == nil {
			v.serverMuted[guildID] = map[string]bool{}
		}
		v.serverMuted[guildID][userID] = true
	} else {
		delete(v.serverMuted[guildID], userID)
	}
	channelID := v.byUser[userID]
	if ch := v.channels[channelID]; ch != nil && ch.guildID == guildID && ch.members[userID] != nil {
		ch.members[userID].ServerMuted = muted
		return channelID
	}
	return ""
}

// connectedIn lists who is connected to the server's voice channels, by channel.
func (v *voiceManager) connectedIn(guildID string) map[string][]string {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := map[string][]string{}
	for id, ch := range v.channels {
		if ch.guildID != guildID {
			continue
		}
		for user := range ch.members {
			out[id] = append(out[id], user)
		}
	}
	return out
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
// limit is the channel's user limit (0: none); bypass ignores it (moderators).
func (v *voiceManager) join(guildID, channelID, userID string, limit int, bypass bool) (string, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	previous := v.byUser[userID]
	if previous == channelID {
		return "", true
	}
	ch := v.channels[channelID]
	count := 0
	if ch != nil {
		count = len(ch.members)
	}
	if count >= maxVoiceMembers || (limit > 0 && count >= limit && !bypass) {
		return "", false
	}
	if previous != "" {
		v.removeLocked(previous, userID)
	}
	if ch == nil {
		ch = &voiceChannel{guildID: guildID, members: map[string]*voiceMember{}}
		v.channels[channelID] = ch
	}
	ch.members[userID] = &voiceMember{UserID: userID, JoinedAt: time.Now().UTC(), ServerMuted: v.serverMuted[guildID][userID]}
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
	m.Muted, m.Deafened, m.Video, m.Screen = muted || m.ServerMuted, deafened, video, screen
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
	// Only people who can see the channel learn who is in it.
	ids, _ := s.guilds.ChannelViewers(ctx, guildID, channelID)
	s.hub.emit(voiceEvent{Type: "voice", GuildID: guildID, ChannelID: channelID, Members: members}, ids...)
}

// voiceSources is what a member may publish in a voice channel.
func (s *Server) voiceSources(a guilds.Access, guildID, channelID string) []string {
	sources := []string{}
	if a.Can(channelID, guilds.PermSpeak) && !s.voice.isServerMuted(guildID, a.UserID) {
		sources = append(sources, livekit.SourceMicrophone)
	}
	if a.Can(channelID, guilds.PermVideo) {
		sources = append(sources, livekit.SourceCamera, livekit.SourceScreenShare, livekit.SourceScreenShareAudio)
	}
	return sources
}

type voiceJoinResponse struct {
	ChannelID string `json:"channelId"`
	GuildID   string `json:"guildId"`
	URL       string `json:"url"`
	Token     string `json:"token"`
}

func (s *Server) voiceToken(a guilds.Access, ch guilds.Channel, name string) (voiceJoinResponse, error) {
	token, err := s.livekit.JoinTokenWith(voiceRoom(ch.ID), a.UserID, name, callTokenTTL, s.voiceSources(a, ch.GuildID, ch.ID))
	return voiceJoinResponse{ChannelID: ch.ID, GuildID: ch.GuildID, URL: s.livekit.URL, Token: token}, err
}

// reconcileVoice applies permission changes to people already connected:
// those who can no longer connect are disconnected, the rest get updated publish rights.
func (s *Server) reconcileVoice(guildID string) {
	connected := s.voice.connectedIn(guildID)
	if len(connected) == 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		all, err := s.guilds.AccessAll(ctx, guildID)
		if err != nil {
			return
		}
		for channelID, users := range connected {
			for _, user := range users {
				a, ok := all[user]
				if !ok || !a.Can(channelID, guilds.PermConnect) {
					s.leaveVoice(user, true)
					continue
				}
				if err := s.livekit.UpdatePermissions(ctx, voiceRoom(channelID), user, s.voiceSources(a, guildID, channelID)); err != nil {
					log.Printf("voice %s: permissions for %s: %v", channelID, user, err)
				}
			}
		}
	}()
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
	ch, a, ok := s.channelForMember(c, u.ID)
	if !ok {
		return
	}
	if ch.Kind != "voice" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Este não é um canal de voz."})
		return
	}
	if !a.Can(ch.ID, guilds.PermConnect) {
		forbidden(c, "Você não tem permissão para entrar neste canal de voz.")
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
	join, err := s.voiceToken(a, ch, u.Username)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível entrar no canal de voz."})
		return
	}
	previous, ok := s.voice.join(ch.GuildID, ch.ID, u.ID, ch.UserLimit, a.Can(ch.ID, guilds.PermMoveMembers))
	if !ok {
		msg := "Este canal de voz está cheio."
		if ch.UserLimit > 0 {
			msg = "Este canal de voz está cheio (" + strconv.Itoa(ch.UserLimit) + "/" + strconv.Itoa(ch.UserLimit) + ")."
		}
		c.JSON(http.StatusConflict, gin.H{"error": msg})
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
	c.JSON(http.StatusOK, join)
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
	var a guilds.Access
	if err == nil {
		a, err = s.guilds.Access(c.Request.Context(), ch.GuildID, u.ID)
	}
	if err != nil || !a.Can(ch.ID, guilds.PermConnect) {
		s.leaveVoice(u.ID, true)
		c.JSON(http.StatusOK, gin.H{"channelId": nil})
		return
	}
	join, err := s.voiceToken(a, ch, u.Username)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível retomar o canal de voz."})
		return
	}
	c.JSON(http.StatusOK, join)
}

// voiceTarget loads the member a moderator acts on, the channel they are in,
// and checks the moderator has perm there and outranks them.
func (s *Server) voiceTarget(c *gin.Context, perm uint64) (guilds.Access, guilds.Access, guilds.Channel, bool) {
	u, ok := s.currentUser(c)
	if !ok {
		return guilds.Access{}, guilds.Access{}, guilds.Channel{}, false
	}
	targetID := c.Param("userId")
	channelID := s.voice.channelOf(targetID)
	ch, err := s.guilds.Channel(c.Request.Context(), channelID)
	if channelID == "" || err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Esta pessoa não está em um canal de voz."})
		return guilds.Access{}, guilds.Access{}, guilds.Channel{}, false
	}
	actor, err1 := s.guilds.Access(c.Request.Context(), ch.GuildID, u.ID)
	target, err2 := s.guilds.Access(c.Request.Context(), ch.GuildID, targetID)
	if err1 != nil || err2 != nil || !actor.Can(ch.ID, guilds.PermViewChannel) {
		c.JSON(http.StatusNotFound, gin.H{"error": "Esta pessoa não está em um canal de voz."})
		return guilds.Access{}, guilds.Access{}, guilds.Channel{}, false
	}
	if !actor.Can(ch.ID, perm) {
		forbidden(c, "")
		return guilds.Access{}, guilds.Access{}, guilds.Channel{}, false
	}
	if targetID != u.ID && !actor.Outranks(target) {
		forbidden(c, "Você só pode moderar quem tem um cargo abaixo do seu.")
		return guilds.Access{}, guilds.Access{}, guilds.Channel{}, false
	}
	return actor, target, ch, true
}

type voiceMovedEvent struct {
	Type string `json:"type"`
	voiceJoinResponse
}

// moveVoiceMember drags someone into another voice channel of the same server.
func (s *Server) moveVoiceMember(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	actor, target, from, ok := s.voiceTarget(c, guilds.PermMoveMembers)
	if !ok {
		return
	}
	var body struct {
		ChannelID string `json:"channelId"`
	}
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	to, err := s.guilds.Channel(c.Request.Context(), body.ChannelID)
	if err != nil || to.GuildID != from.GuildID || to.Kind != "voice" || !actor.Can(to.ID, guilds.PermViewChannel) {
		c.JSON(http.StatusNotFound, gin.H{"error": "Canal de voz não encontrado."})
		return
	}
	if !actor.Can(to.ID, guilds.PermMoveMembers|guilds.PermConnect) || !target.Can(to.ID, guilds.PermViewChannel) {
		forbidden(c, "Não é possível mover esta pessoa para esse canal.")
		return
	}
	if to.ID == from.ID {
		c.Status(http.StatusNoContent)
		return
	}
	name := target.UserID
	if acct, err := s.accounts.Contact(c.Request.Context(), target.UserID); err == nil {
		name = acct.Username
	}
	join, err := s.voiceToken(target, to, name)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível mover."})
		return
	}
	// Moderators can move people into full channels, like Discord.
	if _, ok := s.voice.join(to.GuildID, to.ID, target.UserID, 0, true); !ok {
		c.JSON(http.StatusConflict, gin.H{"error": "Este canal de voz está cheio."})
		return
	}
	s.disconnectVoice(from.ID, target.UserID)
	s.hub.emit(voiceMovedEvent{Type: "voice_moved", voiceJoinResponse: join}, target.UserID)
	s.emitVoice(from.GuildID, from.ID)
	s.emitVoice(to.GuildID, to.ID)
	c.Status(http.StatusNoContent)
}

// muteVoiceMember sets or lifts a server mute; LiveKit stops accepting their microphone.
func (s *Server) muteVoiceMember(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	_, target, ch, ok := s.voiceTarget(c, guilds.PermMuteMembers)
	if !ok {
		return
	}
	var body struct {
		Muted bool `json:"muted"`
	}
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	if channelID := s.voice.setServerMute(ch.GuildID, target.UserID, body.Muted); channelID != "" {
		if body.Muted {
			s.voice.mu.Lock()
			if m := s.voice.channels[channelID].members[target.UserID]; m != nil {
				m.Muted = true
			}
			s.voice.mu.Unlock()
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
		defer cancel()
		if err := s.livekit.UpdatePermissions(ctx, voiceRoom(channelID), target.UserID, s.voiceSources(target, ch.GuildID, channelID)); err != nil {
			log.Printf("voice %s: mute %s: %v", channelID, target.UserID, err)
		}
		s.emitVoice(ch.GuildID, channelID)
	}
	c.Status(http.StatusNoContent)
}

// disconnectVoiceMember takes someone out of voice without removing them from the server.
func (s *Server) disconnectVoiceMember(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	_, target, _, ok := s.voiceTarget(c, guilds.PermMoveMembers)
	if !ok {
		return
	}
	s.leaveVoice(target.UserID, true)
	c.Status(http.StatusNoContent)
}
