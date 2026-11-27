package server

import (
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/Darrkkens/go-live/internal/accounts"
	"github.com/gin-gonic/gin"
)

const sessionCookie = "go_live_session"

func (s *Server) currentUser(c *gin.Context) (accounts.User, bool) {
	token, err := c.Cookie(sessionCookie)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Não autenticado."})
		return accounts.User{}, false
	}
	u, err := s.accounts.Session(c.Request.Context(), token)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Não autenticado."})
		return accounts.User{}, false
	}
	return u, true
}

func (s *Server) master(c *gin.Context) (accounts.User, bool) {
	u, ok := s.currentUser(c)
	if !ok {
		return u, false
	}
	if u.Role != "master" {
		c.JSON(http.StatusForbidden, gin.H{"error": "Acesso restrito ao admin master."})
		return u, false
	}
	return u, true
}

func (s *Server) sameOrigin(c *gin.Context) bool {
	origin := c.GetHeader("Origin")
	allowed := os.Getenv("FRONTEND_ORIGIN")
	if allowed == "" {
		allowed = "http://localhost:5173"
	}
	if origin != allowed {
		c.JSON(http.StatusForbidden, gin.H{"error": "Origem não permitida."})
		return false
	}
	return true
}

func (s *Server) login(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	var body struct {
		Identifier string `json:"identifier"`
		Password   string `json:"password"`
	}
	if c.ShouldBindJSON(&body) != nil || len(body.Identifier) > 254 || len(body.Password) > 1024 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	u, token, err := s.accounts.Login(c.Request.Context(), body.Identifier, body.Password)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Credenciais inválidas."})
		return
	}
	secure := strings.EqualFold(os.Getenv("APP_ENV"), "production")
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(sessionCookie, token, 7*24*60*60, "/", "", secure, true)
	c.JSON(http.StatusOK, u)
}

func (s *Server) logout(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	if token, err := c.Cookie(sessionCookie); err == nil {
		_ = s.accounts.Logout(c.Request.Context(), token)
	}
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(sessionCookie, "", -1, "/", "", strings.EqualFold(os.Getenv("APP_ENV"), "production"), true)
	c.Status(http.StatusNoContent)
}

func (s *Server) me(c *gin.Context) {
	if u, ok := s.currentUser(c); ok {
		c.JSON(http.StatusOK, u)
	}
}

func (s *Server) updateMe(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	var body struct {
		Status string `json:"status"`
	}
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	updated, err := s.accounts.SetProfile(c.Request.Context(), u.ID, body.Status)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Status inválido."})
		return
	}
	c.JSON(http.StatusOK, updated)
}

func (s *Server) changePassword(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	err := s.accounts.ChangePassword(c.Request.Context(), u.ID, body.CurrentPassword, body.NewPassword)
	if errors.Is(err, accounts.ErrInvalid) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "A nova senha precisa ter entre 12 e 1024 caracteres."})
		return
	}
	if errors.Is(err, accounts.ErrUnauthorized) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Senha atual incorreta."})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível alterar a senha."})
		return
	}
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(sessionCookie, "", -1, "/", "", strings.EqualFold(os.Getenv("APP_ENV"), "production"), true)
	c.Status(http.StatusNoContent)
}

func (s *Server) listUsers(c *gin.Context) {
	if _, ok := s.master(c); !ok {
		return
	}
	users, err := s.accounts.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível listar usuários."})
		return
	}
	c.JSON(http.StatusOK, users)
}

func (s *Server) listContacts(c *gin.Context) {
	u, ok := s.currentUser(c)
	if !ok {
		return
	}
	contacts, err := s.accounts.ListContacts(c.Request.Context(), u.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível listar contatos."})
		return
	}
	c.JSON(http.StatusOK, contacts)
}

func (s *Server) createUser(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	if _, ok := s.master(c); !ok {
		return
	}
	var body accounts.CreateInput
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	u, err := s.accounts.Create(c.Request.Context(), body, "user")
	if errors.Is(err, accounts.ErrInvalid) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Confira nome, e-mail, tag e senha de pelo menos 12 caracteres."})
		return
	}
	if errors.Is(err, accounts.ErrConflict) {
		c.JSON(http.StatusConflict, gin.H{"error": "E-mail ou tag já cadastrado."})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Não foi possível criar usuário."})
		return
	}
	c.JSON(http.StatusCreated, u)
}

func (s *Server) updateUserStatus(c *gin.Context) {
	if !s.sameOrigin(c) {
		return
	}
	if _, ok := s.master(c); !ok {
		return
	}
	var body struct {
		AccountStatus string `json:"accountStatus"`
	}
	if c.ShouldBindJSON(&body) != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos."})
		return
	}
	err := s.accounts.SetAccountStatus(c.Request.Context(), c.Param("id"), body.AccountStatus)
	if errors.Is(err, accounts.ErrInvalid) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Status inválido."})
		return
	}
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Usuário não encontrado."})
		return
	}
	c.Status(http.StatusNoContent)
}
