package livekit

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestJoinToken(t *testing.T) {
	cfg := Config{APIKey: "key", APISecret: strings.Repeat("s", 32)}
	token, err := cfg.JoinToken("call-1", "user-1", "Ana", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("not a JWT: %s", token)
	}
	mac := hmac.New(sha256.New, []byte(cfg.APISecret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) != parts[2] {
		t.Fatal("bad signature")
	}
	raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var got claims
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Issuer != "key" || got.Subject != "user-1" || got.Video.Room != "call-1" || !got.Video.RoomJoin || got.Video.RoomCreate || *got.Video.CanPublishData {
		t.Fatalf("claims: %+v", got)
	}
	if got.ExpiresAt-time.Now().Unix() > 61 {
		t.Fatal("ttl too long")
	}
	if _, err := (Config{APIKey: "k", APISecret: "short"}).JoinToken("r", "u", "n", time.Minute); err == nil {
		t.Fatal("short secret accepted")
	}
}

func TestFromEnvDefaults(t *testing.T) {
	t.Setenv("LIVEKIT_URL", "wss://rtc.example.com")
	t.Setenv("LIVEKIT_API_URL", "")
	if cfg := FromEnv(); cfg.APIURL != "https://rtc.example.com" {
		t.Fatalf("api url: %s", cfg.APIURL)
	}
}
