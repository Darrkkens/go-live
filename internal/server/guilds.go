package server

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/Darrkkens/go-live/internal/guilds"
	"github.com/Darrkkens/go-live/internal/messages"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// guildEvent tells members to reload a server, or that they no longer belong to it.
type guildEvent struct {
	Type    string `json:"type"`
	GuildID string `json:"guildId"`
	Action  string `json:"action"`
}

// audience lists who receives realtime events about a message.
func (s *Server) audience(ctx context.Context, m messages.Message) []string {
	if m.ChannelID == "" {
		return []string{m.SenderID, m.RecipientID}
	}
	ch, err := s.guilds.Channel(ctx, m.ChannelID)
	if err != nil {
		return nil
	}
	ids, _ := s.guilds.MemberIDs(ctx, ch.GuildID)
	return ids
}

func (s *Server) emitMessage(kind string, m messages.Message) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.hub.emit(messageEvent{Type: kind, Message: m}, s.audience(ctx, m)...)
}

// canSee reports whether the user may read a message.
func (s *Server) canSee(ctx context.Context, userID string, m messages.Message) bool {
	if m.ChannelID == "" {
		return m.SenderID == userID || m.RecipientID == userID
	}
	ch, err := s.guilds.Channel(ctx, m.ChannelID)
	if err != nil {
		return false
	}
	_, err = s.guilds.Role(ctx, ch.GuildID, userID)
	return err == nil
}

func (s *Server) notifyGuild(guildID, action string, extra ...string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ids, _ := s.guilds.MemberIDs(ctx, guildID)
	s.hub.emit(guildEvent{Type: "guild", GuildID: guildID, Action: action}, append(ids, extra...)...)
}

func removeFiles(files []string) {
	for _, f := range files {
		if err := os.Remove(filepath.Join(attachmentDir(), filepath.Base(f))); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("could not remove attachment %s: %v", f, err)
		}
	}
}

// guildRole loads the URL's server and requires at least minRole.
func (s *Server) guildRole(c *gin.Context, userID, minRole string) (string, string, bool) {
	guildID := c.Param("id")
	if _, err := uuid.Parse(guildID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Servidor não encontrado."})
		return "", "", false
	}
	role, err := s.guilds.Role(c.Request.Context(), guildID, userID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Servidor não encontrado."})
		return "", "", false
	}
	if guilds.Rank(role) < guilds.Rank(minRole) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Você não tem permissão para isso neste servidor."})
		return "", "", false
	}
	return guildID, role, true
}

// channelForMember loads the URL's channel if the user belongs to its server.
func (s *Server) channelForMember(c *gin.Context, userID string) (guilds.Channel, string, bool) {
	id := c.Param("channelId")
	if _, err := uuid.Parse(id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Canal não encontrado."})
		return guilds.Channel{}, "", false
	}
	ch, err := s.guilds.Channel(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Canal não encontrado."})
		return guilds.Channel{}, "", false
	}
	role, err := s.guilds.Role(c.Request.Context(), ch.GuildID, userID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Canal não encontrado."})
		return guilds.Channel{}, "", false
	}
	return ch, role, true
}

type guildDetail struct {
	guilds.Guild
	Channels []guilds.Channel         `json:"channels"`
	Members  []guilds.Member          `json:"members"`
	Unread   map[string]int           `json:"unread"`
	Voice    map[string][]voiceMember `json:"voice"`
}

func (s *Server) listGuilds(c *gin.Context) {
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	list, err := s.guilds.ListForUser(c.Request.Context(), u.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível carregar os servidores."})
		return
	}
	// Unread totals let the server rail show a dot on servers with news.
	type item struct {
		guilds.Guild
		Unread int `json:"unread"`
	}
	out := make([]item, 0, len(list))
	for _, g := range list {
		channels, _ := s.guilds.Channels(c.Request.Context(), g.ID)
		ids := make([]string, 0, len(channels))
		for _, ch := range channels {
			ids = append(ids, ch.ID)
		}
		counts, _ := s.messages.ChannelUnread(c.Request.Context(), u.ID, ids)
		total := 0
		for _, n := range counts {
			total += n
		}
		out = append(out, item{Guild: g, Unread: total})
	}
	c.JSON(http.StatusOK, out)
}

func (s *Server) createGuild(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	g, err := s.guilds.Create(c.Request.Context(), u.ID, body.Name)
	if errors.Is(err, guilds.ErrInvalid) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "O nome do servidor precisa ter entre 2 e 60 caracteres."})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível criar o servidor."})
		return
	}
	c.JSON(http.StatusCreated, g)
}

func (s *Server) getGuild(c *gin.Context) {
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	guildID, _, ok := s.guildRole(c, u.ID, guilds.RoleMember)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	g, err1 := s.guilds.Get(ctx, guildID, u.ID)
	channels, err2 := s.guilds.Channels(ctx, guildID)
	members, err3 := s.guilds.Members(ctx, guildID)
	if err := errors.Join(err1, err2, err3); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível carregar o servidor."})
		return
	}
	ids := make([]string, 0, len(channels))
	for _, ch := range channels {
		ids = append(ids, ch.ID)
	}
	unread, _ := s.messages.ChannelUnread(ctx, u.ID, ids)
	// Presence follows the realtime connection, as in the contact list.
	for i := range members {
		if members[i].UserID != u.ID && !s.hub.online(members[i].UserID) {
			members[i].Status = "offline"
		}
	}
	c.JSON(http.StatusOK, guildDetail{Guild: g, Channels: channels, Members: members, Unread: unread, Voice: s.voice.forGuild(guildID)})
}

func (s *Server) updateGuild(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	guildID, _, ok := s.guildRole(c, u.ID, guilds.RoleOwner)
	if !ok {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	if err := s.guilds.Rename(c.Request.Context(), guildID, body.Name); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "O nome do servidor precisa ter entre 2 e 60 caracteres."})
		return
	}
	s.notifyGuild(guildID, "updated")
	c.Status(http.StatusNoContent)
}

func (s *Server) deleteGuild(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	guildID, _, ok := s.guildRole(c, u.ID, guilds.RoleOwner)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	members, _ := s.guilds.MemberIDs(ctx, guildID)
	files, _ := s.guilds.AttachmentFiles(ctx, guildID)
	g, _ := s.guilds.Get(ctx, guildID, u.ID)
	channels, _ := s.guilds.Channels(ctx, guildID)
	if err := s.guilds.Delete(ctx, guildID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível excluir o servidor."})
		return
	}
	removeFiles(files)
	removeStoredImage(g.Icon)
	for _, ch := range channels {
		if ch.Kind == "voice" {
			s.closeVoiceChannel(guildID, ch.ID)
		}
	}
	s.hub.emit(guildEvent{Type: "guild", GuildID: guildID, Action: "removed"}, members...)
	c.Status(http.StatusNoContent)
}

// guildIcon sets (POST, multipart "icon") or removes (DELETE) the server image.
func (s *Server) guildIcon(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	guildID, _, ok := s.guildRole(c, u.ID, guilds.RoleAdmin)
	if !ok {
		return
	}
	icon := ""
	if c.Request.Method == http.MethodPost {
		name, ok := saveUploadedImage(c, "icon")
		if !ok {
			return
		}
		icon = "/api/avatars/" + name
	}
	old, err := s.guilds.SetIcon(c.Request.Context(), guildID, icon)
	if err != nil {
		removeStoredImage(icon)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível atualizar a imagem do servidor."})
		return
	}
	removeStoredImage(old)
	s.notifyGuild(guildID, "updated")
	c.JSON(http.StatusOK, gin.H{"icon": icon})
}

func (s *Server) leaveGuild(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	guildID, role, ok := s.guildRole(c, u.ID, guilds.RoleMember)
	if !ok {
		return
	}
	if role == guilds.RoleOwner {
		c.JSON(http.StatusConflict, gin.H{"error": "O dono não pode sair. Exclua o servidor ou continue como dono."})
		return
	}
	if err := s.guilds.RemoveMember(c.Request.Context(), guildID, u.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível sair do servidor."})
		return
	}
	s.leaveVoiceInGuild(u.ID, guildID)
	s.hub.emit(guildEvent{Type: "guild", GuildID: guildID, Action: "removed"}, u.ID)
	s.notifyGuild(guildID, "updated")
	c.Status(http.StatusNoContent)
}

func (s *Server) addGuildMember(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	guildID, _, ok := s.guildRole(c, u.ID, guilds.RoleAdmin)
	if !ok {
		return
	}
	var body struct {
		UserID string `json:"userId"`
	}
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	if _, err := uuid.Parse(body.UserID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Usuário não encontrado."})
		return
	}
	added, err := s.guilds.AddMember(c.Request.Context(), guildID, body.UserID)
	if errors.Is(err, guilds.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "Usuário não encontrado."})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível adicionar o membro."})
		return
	}
	if added {
		s.notifyGuild(guildID, "updated")
	}
	c.Status(http.StatusNoContent)
}

func (s *Server) updateGuildMember(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	guildID, _, ok := s.guildRole(c, u.ID, guilds.RoleOwner)
	if !ok {
		return
	}
	var body struct {
		Role string `json:"role"`
	}
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	err := s.guilds.SetRole(c.Request.Context(), guildID, c.Param("userId"), body.Role)
	if errors.Is(err, guilds.ErrInvalid) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Cargo inválido."})
		return
	}
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Membro não encontrado."})
		return
	}
	s.notifyGuild(guildID, "updated")
	c.Status(http.StatusNoContent)
}

func (s *Server) removeGuildMember(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	guildID, role, ok := s.guildRole(c, u.ID, guilds.RoleAdmin)
	if !ok {
		return
	}
	target := c.Param("userId")
	targetRole, err := s.guilds.Role(c.Request.Context(), guildID, target)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Membro não encontrado."})
		return
	}
	// Admins remove members; only the owner removes admins; nobody removes the owner.
	if guilds.Rank(targetRole) >= guilds.Rank(role) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Você não pode remover este membro."})
		return
	}
	if err := s.guilds.RemoveMember(c.Request.Context(), guildID, target); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Membro não encontrado."})
		return
	}
	s.leaveVoiceInGuild(target, guildID)
	s.hub.emit(guildEvent{Type: "guild", GuildID: guildID, Action: "removed"}, target)
	s.notifyGuild(guildID, "updated")
	c.Status(http.StatusNoContent)
}

func (s *Server) createChannel(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	guildID, _, ok := s.guildRole(c, u.ID, guilds.RoleAdmin)
	if !ok {
		return
	}
	var body struct {
		Name  string `json:"name"`
		Topic string `json:"topic"`
		Kind  string `json:"kind"`
	}
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	if body.Kind == "" {
		body.Kind = "text"
	}
	ch, err := s.guilds.CreateChannel(c.Request.Context(), guildID, body.Name, body.Topic, body.Kind)
	if errors.Is(err, guilds.ErrInvalid) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Use um nome de canal com até 40 letras ou números e um tópico de até 200 caracteres."})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível criar o canal."})
		return
	}
	s.notifyGuild(guildID, "updated")
	c.JSON(http.StatusCreated, ch)
}

func (s *Server) updateChannel(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	ch, role, ok := s.channelForMember(c, u.ID)
	if !ok {
		return
	}
	if guilds.Rank(role) < guilds.Rank(guilds.RoleAdmin) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Só donos e admins editam canais."})
		return
	}
	var body struct {
		Name  string `json:"name"`
		Topic string `json:"topic"`
	}
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	updated, err := s.guilds.UpdateChannel(c.Request.Context(), ch.ID, body.Name, body.Topic)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Use um nome de canal com até 40 letras ou números e um tópico de até 200 caracteres."})
		return
	}
	s.notifyGuild(ch.GuildID, "updated")
	c.JSON(http.StatusOK, updated)
}

func (s *Server) deleteChannel(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	ch, role, ok := s.channelForMember(c, u.ID)
	if !ok {
		return
	}
	if guilds.Rank(role) < guilds.Rank(guilds.RoleAdmin) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Só donos e admins excluem canais."})
		return
	}
	files, err := s.guilds.DeleteChannel(c.Request.Context(), ch.ID)
	if errors.Is(err, guilds.ErrLastChannel) {
		c.JSON(http.StatusConflict, gin.H{"error": "O servidor precisa ter pelo menos um canal de texto."})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível excluir o canal."})
		return
	}
	removeFiles(files)
	if ch.Kind == "voice" {
		s.closeVoiceChannel(ch.GuildID, ch.ID)
	}
	s.notifyGuild(ch.GuildID, "updated")
	c.Status(http.StatusNoContent)
}

func (s *Server) channelMessages(c *gin.Context) {
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	ch, _, ok := s.channelForMember(c, u.ID)
	if !ok {
		return
	}
	before, _ := strconv.ParseInt(c.Query("before"), 10, 64)
	limit, _ := strconv.Atoi(c.Query("limit"))
	list, err := s.messages.ChannelHistory(c.Request.Context(), ch.ID, before, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível carregar as mensagens."})
		return
	}
	c.JSON(http.StatusOK, list)
}

func (s *Server) sendChannelMessage(c *gin.Context) {
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
	var body struct {
		Body string `json:"body"`
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	m, err := s.messages.SendToChannel(c.Request.Context(), u.ID, ch.ID, body.Body, nil)
	if errors.Is(err, messages.ErrInvalid) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "A mensagem precisa ter entre 1 e 4000 caracteres."})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível enviar a mensagem."})
		return
	}
	s.emitMessage("message", m)
	c.JSON(http.StatusCreated, m)
}

func (s *Server) markChannelRead(c *gin.Context) {
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
	if err := s.messages.MarkChannelRead(c.Request.Context(), u.ID, ch.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível atualizar o canal."})
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Server) createInvite(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	guildID, _, ok := s.guildRole(c, u.ID, guilds.RoleAdmin)
	if !ok {
		return
	}
	var body struct {
		ExpiresInHours int `json:"expiresInHours"`
		MaxUses        int `json:"maxUses"`
	}
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	inv, err := s.guilds.CreateInvite(c.Request.Context(), guildID, u.ID, time.Duration(body.ExpiresInHours)*time.Hour, body.MaxUses)
	if errors.Is(err, guilds.ErrInvalid) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Escolha uma validade de até 30 dias e até 1000 usos."})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível criar o convite."})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"invite": inv, "url": frontendOrigin() + "/convite/" + inv.Code})
}

func (s *Server) previewInvite(c *gin.Context) {
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	p, err := s.guilds.Preview(c.Request.Context(), c.Param("code"), u.ID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Este convite é inválido, expirou ou já foi usado."})
		return
	}
	c.JSON(http.StatusOK, p)
}

func (s *Server) acceptInvite(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	guildID, joined, err := s.guilds.Accept(c.Request.Context(), c.Param("code"), u.ID)
	if errors.Is(err, guilds.ErrInviteInvalid) {
		c.JSON(http.StatusNotFound, gin.H{"error": "Este convite é inválido, expirou ou já foi usado."})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível entrar no servidor."})
		return
	}
	if joined {
		s.notifyGuild(guildID, "updated")
	}
	c.JSON(http.StatusOK, gin.H{"guildId": guildID})
}
