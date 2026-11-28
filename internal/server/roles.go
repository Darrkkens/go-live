package server

import (
	"errors"
	"net/http"

	"github.com/Darrkkens/go-live/internal/guilds"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// canGrant reports whether the member may give these permissions: you cannot
// hand out what you do not have, unless you are the owner or an administrator.
func canGrant(a guilds.Access, perms uint64) bool {
	return a.Guild()&perms == perms
}

// roleForEdit loads the URL's role and checks it sits below the member's top role.
func (s *Server) roleForEdit(c *gin.Context, guildID string, a guilds.Access) (guilds.Role, bool) {
	r, err := s.guilds.RoleByID(c.Request.Context(), guildID, c.Param("roleId"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Cargo não encontrado."})
		return guilds.Role{}, false
	}
	if !r.IsDefault && !a.Owner && r.Position >= a.Top() {
		forbidden(c, "Você só pode alterar cargos abaixo do seu.")
		return guilds.Role{}, false
	}
	return r, true
}

type roleBody struct {
	Name        string `json:"name"`
	Color       string `json:"color"`
	Permissions uint64 `json:"permissions"`
}

func (s *Server) createRole(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	guildID, a, ok := s.guildAccess(c, u.ID, guilds.PermManageRoles)
	if !ok {
		return
	}
	var body roleBody
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	if !canGrant(a, body.Permissions) {
		forbidden(c, "Você não pode dar permissões que você mesmo não tem.")
		return
	}
	r, err := s.guilds.CreateRole(c.Request.Context(), guildID, body.Name, body.Color, body.Permissions)
	if errors.Is(err, guilds.ErrInvalid) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Use um nome de 1 a 32 caracteres (não pode ser @todos). Um servidor tem até 50 cargos."})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível criar o cargo."})
		return
	}
	s.notifyGuild(guildID, "updated")
	c.JSON(http.StatusCreated, r)
}

func (s *Server) updateRole(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	guildID, a, ok := s.guildAccess(c, u.ID, guilds.PermManageRoles)
	if !ok {
		return
	}
	current, ok := s.roleForEdit(c, guildID, a)
	if !ok {
		return
	}
	var body roleBody
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	// Only the permissions that change must be ones you have.
	if !canGrant(a, body.Permissions^current.Permissions) {
		forbidden(c, "Você não pode mudar permissões que você mesmo não tem.")
		return
	}
	r, err := s.guilds.UpdateRole(c.Request.Context(), guildID, current.ID, body.Name, body.Color, body.Permissions)
	if errors.Is(err, guilds.ErrInvalid) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Use um nome de 1 a 32 caracteres e uma cor no formato #RRGGBB."})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível salvar o cargo."})
		return
	}
	s.notifyGuild(guildID, "updated")
	s.reconcileVoice(guildID)
	c.JSON(http.StatusOK, r)
}

func (s *Server) deleteRole(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	guildID, a, ok := s.guildAccess(c, u.ID, guilds.PermManageRoles)
	if !ok {
		return
	}
	r, ok := s.roleForEdit(c, guildID, a)
	if !ok {
		return
	}
	if err := s.guilds.DeleteRole(c.Request.Context(), guildID, r.ID); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "O cargo @todos não pode ser excluído."})
		return
	}
	s.notifyGuild(guildID, "updated")
	s.reconcileVoice(guildID)
	c.Status(http.StatusNoContent)
}

func (s *Server) moveRole(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	guildID, a, ok := s.guildAccess(c, u.ID, guilds.PermManageRoles)
	if !ok {
		return
	}
	r, ok := s.roleForEdit(c, guildID, a)
	if !ok {
		return
	}
	var body struct {
		Direction string `json:"direction"`
	}
	if c.ShouldBindJSON(&body) != nil || (body.Direction != "up" && body.Direction != "down") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	up := body.Direction == "up"
	// Moving up swaps with the role above, which must also be below you.
	if up && !a.Owner && r.Position+1 >= a.Top() {
		forbidden(c, "Um cargo não pode ficar acima do seu.")
		return
	}
	if _, err := s.guilds.MoveRole(c.Request.Context(), guildID, r.ID, up); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Este cargo já está no limite da lista."})
		return
	}
	s.notifyGuild(guildID, "updated")
	c.Status(http.StatusNoContent)
}

func (s *Server) setMemberRoles(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	guildID, a, ok := s.guildAccess(c, u.ID, guilds.PermManageRoles)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	target, err := s.guilds.Access(ctx, guildID, c.Param("userId"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Membro não encontrado."})
		return
	}
	if target.UserID != u.ID && !a.Outranks(target) {
		forbidden(c, "Você só pode mudar os cargos de quem está abaixo de você.")
		return
	}
	var body struct {
		RoleIDs []string `json:"roleIds"`
	}
	if c.ShouldBindJSON(&body) != nil || len(body.RoleIDs) > 50 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	// Every role added or removed must be below your top role.
	before := map[string]bool{}
	for _, id := range target.RoleIDs() {
		before[id] = true
	}
	after := map[string]bool{}
	for _, id := range body.RoleIDs {
		if _, err := uuid.Parse(id); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Cargo inválido."})
			return
		}
		after[id] = true
	}
	for id := range mergeKeys(before, after) {
		if before[id] == after[id] {
			continue
		}
		r, err := s.guilds.RoleByID(ctx, guildID, id)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Cargo inválido."})
			return
		}
		if !a.Owner && r.Position >= a.Top() {
			forbidden(c, "Você só pode dar ou tirar cargos abaixo do seu.")
			return
		}
	}
	if err := s.guilds.SetMemberRoles(ctx, guildID, target.UserID, body.RoleIDs); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Cargo inválido."})
		return
	}
	s.notifyGuild(guildID, "updated")
	s.reconcileVoice(guildID)
	c.Status(http.StatusNoContent)
}

func mergeKeys(a, b map[string]bool) map[string]bool {
	out := map[string]bool{}
	for k := range a {
		out[k] = true
	}
	for k := range b {
		out[k] = true
	}
	return out
}

// setOverride changes what one role may do in one channel (private channels, read-only channels).
func (s *Server) setOverride(c *gin.Context) {
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
	if !a.Can(ch.ID, guilds.PermManageChannels) || !a.Has(guilds.PermManageRoles) {
		forbidden(c, "Você precisa poder gerenciar canais e cargos para mudar as permissões do canal.")
		return
	}
	r, err := s.guilds.RoleByID(c.Request.Context(), ch.GuildID, c.Param("roleId"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Cargo não encontrado."})
		return
	}
	if !r.IsDefault && !a.Owner && r.Position >= a.Top() {
		forbidden(c, "Você só pode ajustar cargos abaixo do seu.")
		return
	}
	var body struct {
		Allow uint64 `json:"allow"`
		Deny  uint64 `json:"deny"`
	}
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	if !canGrant(a, body.Allow|body.Deny) {
		forbidden(c, "Você não pode ajustar permissões que você mesmo não tem.")
		return
	}
	if err := s.guilds.SetOverride(c.Request.Context(), ch.ID, r.ID, body.Allow, body.Deny); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível salvar as permissões do canal."})
		return
	}
	s.notifyGuild(ch.GuildID, "updated")
	s.reconcileVoice(ch.GuildID)
	c.Status(http.StatusNoContent)
}
