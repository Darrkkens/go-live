package server

import (
	"net/http"
	"os"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

func (s *Server) RegisterRoutes() http.Handler {
	r := gin.Default()

	frontendOrigin := os.Getenv("FRONTEND_ORIGIN")
	if frontendOrigin == "" {
		frontendOrigin = "http://localhost:5173"
	}
	r.Use(cors.New(cors.Config{
		AllowOrigins:     []string{frontendOrigin},
		AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"},
		AllowHeaders:     []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: true, // Enable cookies/auth
	}))

	r.GET("/", s.HelloWorldHandler)

	r.GET("/health", s.healthHandler)

	r.POST("/api/auth/login", s.login)
	r.POST("/api/auth/logout", s.logout)
	r.GET("/api/auth/me", s.me)
	r.PATCH("/api/auth/me", s.updateMe)
	r.POST("/api/auth/avatar", s.uploadAvatar)
	r.GET("/api/avatars/:name", s.getAvatar)
	r.POST("/api/auth/change-password", s.changePassword)
	r.GET("/api/users", s.listUsers)
	r.GET("/api/contacts", s.listContacts)
	r.POST("/api/users", s.createUser)
	r.PATCH("/api/users/:id/status", s.updateUserStatus)
	r.GET("/api/conversations", s.listConversations)
	r.GET("/api/conversations/:contactId/messages", s.listMessages)
	r.POST("/api/conversations/:contactId/messages", s.sendMessage)
	r.POST("/api/conversations/:contactId/read", s.markRead)
	r.POST("/api/conversations/:contactId/attachments", s.sendAttachment)
	r.GET("/api/messages/:id/attachment", s.getAttachment)
	r.PATCH("/api/messages/:id", s.editMessage)
	r.DELETE("/api/messages/:id", s.deleteMessage)
	r.GET("/api/calls/current", s.currentCall)
	r.POST("/api/calls", s.startCall)
	r.POST("/api/calls/:id/accept", s.acceptCall)
	r.POST("/api/calls/:id/decline", s.declineCall)
	r.POST("/api/calls/:id/end", s.endCall)
	r.GET("/api/ws", s.realtime)

	return r
}

func (s *Server) HelloWorldHandler(c *gin.Context) {
	resp := make(map[string]string)
	resp["message"] = "Hello World"

	c.JSON(http.StatusOK, resp)
}

func (s *Server) healthHandler(c *gin.Context) {
	c.JSON(http.StatusOK, s.db.Health())
}
