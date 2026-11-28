// Package livekit issues access tokens for a self-hosted LiveKit server and
// calls the small part of its room API the app needs.
package livekit

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// Config holds the LiveKit connection settings.
type Config struct {
	// URL is the WebSocket address browsers connect to, e.g. ws://localhost:7880.
	URL string
	// APIURL is the HTTP address the Go server uses for room management.
	APIURL    string
	APIKey    string
	APISecret string
}

// FromEnv reads LIVEKIT_URL, LIVEKIT_API_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.
func FromEnv() Config {
	cfg := Config{
		URL:       os.Getenv("LIVEKIT_URL"),
		APIURL:    os.Getenv("LIVEKIT_API_URL"),
		APIKey:    os.Getenv("LIVEKIT_API_KEY"),
		APISecret: os.Getenv("LIVEKIT_API_SECRET"),
	}
	if cfg.URL == "" {
		cfg.URL = "ws://localhost:7880"
	}
	if cfg.APIURL == "" {
		cfg.APIURL = "http" + strings.TrimPrefix(cfg.URL, "ws")
	}
	return cfg
}

// Enabled reports whether credentials are configured.
func (c Config) Enabled() bool { return c.APIKey != "" && len(c.APISecret) >= 32 }

type videoGrant struct {
	Room              string   `json:"room,omitempty"`
	RoomJoin          bool     `json:"roomJoin,omitempty"`
	RoomCreate        bool     `json:"roomCreate,omitempty"`
	CanPublish        *bool    `json:"canPublish,omitempty"`
	CanSubscribe      *bool    `json:"canSubscribe,omitempty"`
	CanPublishData    *bool    `json:"canPublishData,omitempty"`
	CanPublishSources []string `json:"canPublishSources,omitempty"`
}

type claims struct {
	Issuer    string     `json:"iss"`
	Subject   string     `json:"sub,omitempty"`
	Name      string     `json:"name,omitempty"`
	NotBefore int64      `json:"nbf"`
	ExpiresAt int64      `json:"exp"`
	Video     videoGrant `json:"video"`
}

func (c Config) sign(cl claims) (string, error) {
	header, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	body, err := json.Marshal(cl)
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding
	unsigned := enc.EncodeToString(header) + "." + enc.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(c.APISecret))
	mac.Write([]byte(unsigned))
	return unsigned + "." + enc.EncodeToString(mac.Sum(nil)), nil
}

// JoinToken lets one user join one room and publish microphone, camera and screen.
func (c Config) JoinToken(room, identity, name string, ttl time.Duration) (string, error) {
	if !c.Enabled() {
		return "", errors.New("livekit is not configured")
	}
	yes, no := true, false
	now := time.Now()
	return c.sign(claims{
		Issuer: c.APIKey, Subject: identity, Name: name,
		NotBefore: now.Add(-10 * time.Second).Unix(), ExpiresAt: now.Add(ttl).Unix(),
		Video: videoGrant{Room: room, RoomJoin: true, CanPublish: &yes, CanSubscribe: &yes, CanPublishData: &no,
			CanPublishSources: []string{"microphone", "camera", "screen_share", "screen_share_audio"}},
	})
}

// DeleteRoom disconnects everyone from a room. A missing room is not an error.
func (c Config) DeleteRoom(ctx context.Context, room string) error {
	if !c.Enabled() {
		return nil
	}
	now := time.Now()
	token, err := c.sign(claims{Issuer: c.APIKey, NotBefore: now.Add(-10 * time.Second).Unix(), ExpiresAt: now.Add(time.Minute).Unix(), Video: videoGrant{RoomCreate: true}})
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]string{"room": room})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.APIURL, "/")+"/twirp/livekit.RoomService/DeleteRoom", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound || res.StatusCode < 300 {
		return nil
	}
	return fmt.Errorf("livekit DeleteRoom: HTTP %d", res.StatusCode)
}
