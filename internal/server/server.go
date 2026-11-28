package server

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	_ "github.com/joho/godotenv/autoload"

	"github.com/Darrkkens/go-live/internal/accounts"
	"github.com/Darrkkens/go-live/internal/database"
	"github.com/Darrkkens/go-live/internal/livekit"
	"github.com/Darrkkens/go-live/internal/messages"
)

type Server struct {
	port int

	db       database.Service
	accounts accounts.Store
	messages messages.Store
	hub      *hub
	calls    *callManager
	livekit  livekit.Config
}

func NewServer() *http.Server {
	port, _ := strconv.Atoi(os.Getenv("PORT"))
	NewServer := &Server{
		port: port,

		db: database.New(),
	}
	NewServer.accounts = accounts.Store{DB: NewServer.db.DB()}
	NewServer.messages = messages.Store{DB: NewServer.db.DB()}
	NewServer.hub = newHub()
	NewServer.calls = newCallManager()
	NewServer.livekit = livekit.FromEnv()
	if !NewServer.livekit.Enabled() {
		log.Printf("LIVEKIT_API_KEY/LIVEKIT_API_SECRET not set (secret needs 32+ characters): calls are disabled")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := NewServer.accounts.Migrate(ctx); err != nil {
		log.Fatalf("database migration failed: %v", err)
	}
	if err := NewServer.messages.Migrate(ctx); err != nil {
		log.Fatalf("messages migration failed: %v", err)
	}

	// Declare Server config
	server := &http.Server{
		Addr:         fmt.Sprintf(":%d", NewServer.port),
		Handler:      NewServer.RegisterRoutes(),
		IdleTimeout:  time.Minute,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	return server
}
