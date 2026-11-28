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
	r.GET("/api/guilds", s.listGuilds)
	r.POST("/api/guilds", s.createGuild)
	r.GET("/api/guilds/:id", s.getGuild)
	r.PATCH("/api/guilds/:id", s.updateGuild)
	r.DELETE("/api/guilds/:id", s.deleteGuild)
	r.POST("/api/guilds/:id/leave", s.leaveGuild)
	r.POST("/api/guilds/:id/icon", s.guildIcon)
	r.DELETE("/api/guilds/:id/icon", s.guildIcon)
	r.POST("/api/guilds/:id/members", s.addGuildMember)
	r.PUT("/api/guilds/:id/members/:userId/roles", s.setMemberRoles)
	r.POST("/api/guilds/:id/roles", s.createRole)
	r.PATCH("/api/guilds/:id/roles/:roleId", s.updateRole)
	r.DELETE("/api/guilds/:id/roles/:roleId", s.deleteRole)
	r.POST("/api/guilds/:id/roles/:roleId/move", s.moveRole)
	r.PUT("/api/channels/:channelId/overrides/:roleId", s.setOverride)
	r.POST("/api/voice/members/:userId/move", s.moveVoiceMember)
	r.POST("/api/voice/members/:userId/mute", s.muteVoiceMember)
	r.POST("/api/voice/members/:userId/disconnect", s.disconnectVoiceMember)
	r.DELETE("/api/guilds/:id/members/:userId", s.removeGuildMember)
	r.POST("/api/guilds/:id/channels", s.createChannel)
	r.POST("/api/guilds/:id/invites", s.createInvite)
	r.PATCH("/api/channels/:channelId", s.updateChannel)
	r.DELETE("/api/channels/:channelId", s.deleteChannel)
	r.GET("/api/channels/:channelId/messages", s.channelMessages)
	r.POST("/api/channels/:channelId/messages", s.sendChannelMessage)
	r.POST("/api/channels/:channelId/attachments", s.sendChannelAttachment)
	r.POST("/api/channels/:channelId/read", s.markChannelRead)
	r.GET("/api/invites/:code", s.previewInvite)
	r.POST("/api/invites/:code/accept", s.acceptInvite)
	r.POST("/api/channels/:channelId/voice/join", s.joinVoice)
	r.POST("/api/voice/leave", s.leaveVoiceHandler)
	r.POST("/api/voice/state", s.voiceState)
	r.GET("/api/voice/current", s.currentVoice)
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
