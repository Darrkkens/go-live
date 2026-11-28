package guilds

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	"github.com/Darrkkens/go-live/internal/accounts"
	"github.com/Darrkkens/go-live/internal/messages"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

func TestNormalizeChannelName(t *testing.T) {
	cases := map[string]string{"Bate Papo!": "bate-papo", "  Avisos  ": "avisos", "música_ao vivo": "música_ao-vivo", "a -- b": "a-b"}
	for in, want := range cases {
		if got, err := NormalizeChannelName(in); err != nil || got != want {
			t.Errorf("%q -> %q %v, want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "!!!", "   "} {
		if _, err := NormalizeChannelName(bad); err != ErrInvalid {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestGuildFlow(t *testing.T) {
	ctx := context.Background()
	container, err := postgres.Run(ctx, "postgres:latest", postgres.WithDatabase("go_live"), postgres.WithUsername("test"), postgres.WithPassword("test"), testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(60*time.Second)))
	if err != nil {
		t.Skipf("Docker unavailable: %v", err)
	}
	defer container.Terminate(ctx)
	host, _ := container.Host(ctx)
	port, _ := container.MappedPort(ctx, "5432/tcp")
	db, err := sql.Open("pgx", fmt.Sprintf("postgres://test:test@%s:%s/go_live?sslmode=disable", host, port.Port()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	users, msgs, store := accounts.Store{DB: db}, messages.Store{DB: db}, Store{DB: db}
	for _, m := range []func(context.Context) error{users.Migrate, msgs.Migrate, store.Migrate, store.Migrate} {
		if err := m(ctx); err != nil {
			t.Fatal(err)
		}
	}
	mk := func(tag string) accounts.User {
		u, err := users.Create(ctx, accounts.CreateInput{Username: tag, Email: tag + "@example.com", UserTag: tag, Password: "long secure password"}, "user")
		if err != nil {
			t.Fatal(err)
		}
		return u
	}
	ana, bia, caio := mk("ana"), mk("bia"), mk("caio")

	if _, err := store.Create(ctx, ana.ID, " x "); err != ErrInvalid {
		t.Fatalf("short name: %v", err)
	}
	g, err := store.Create(ctx, ana.ID, "  Time   Go  ")
	if err != nil || g.Name != "Time Go" || g.Role != RoleOwner {
		t.Fatalf("create: %+v %v", g, err)
	}
	channels, _ := store.Channels(ctx, g.ID)
	if len(channels) != 1 || channels[0].Name != "geral" {
		t.Fatalf("default channel: %+v", channels)
	}
	geral := channels[0]
	if _, err := store.DeleteChannel(ctx, geral.ID); err != ErrLastChannel {
		t.Fatalf("deleted last channel: %v", err)
	}

	// Direct add and roles.
	if added, err := store.AddMember(ctx, g.ID, bia.ID); err != nil || !added {
		t.Fatalf("add: %v", err)
	}
	if added, err := store.AddMember(ctx, g.ID, bia.ID); err != nil || added {
		t.Fatalf("add twice: %v %v", added, err)
	}
	if err := store.SetRole(ctx, g.ID, bia.ID, RoleAdmin); err != nil {
		t.Fatal(err)
	}
	if err := store.SetRole(ctx, g.ID, ana.ID, RoleMember); err != ErrNotFound {
		t.Fatalf("owner demoted: %v", err)
	}
	if err := store.RemoveMember(ctx, g.ID, ana.ID); err != ErrNotFound {
		t.Fatalf("owner removed: %v", err)
	}
	if role, _ := store.Role(ctx, g.ID, bia.ID); role != RoleAdmin {
		t.Fatalf("role: %s", role)
	}
	if _, err := store.Role(ctx, g.ID, caio.ID); err != ErrNotFound {
		t.Fatalf("outsider role: %v", err)
	}

	// Invites: single use, then exhausted; expired invites fail.
	inv, err := store.CreateInvite(ctx, g.ID, ana.ID, time.Hour, 1)
	if err != nil {
		t.Fatal(err)
	}
	if p, err := store.Preview(ctx, inv.Code, caio.ID); err != nil || p.GuildName != "Time Go" || p.MemberCount != 2 || p.Member {
		t.Fatalf("preview: %+v %v", p, err)
	}
	if id, joined, err := store.Accept(ctx, inv.Code, caio.ID); err != nil || !joined || id != g.ID {
		t.Fatalf("accept: %v", err)
	}
	if _, _, err := store.Accept(ctx, inv.Code, caio.ID); err != ErrInviteInvalid {
		t.Fatalf("used-up invite: %v", err)
	}
	old, _ := store.CreateInvite(ctx, g.ID, ana.ID, 0, 0)
	db.ExecContext(ctx, `UPDATE guild_invites SET expires_at=NOW()-interval '1 second' WHERE code=$1`, old.Code)
	if _, err := store.Preview(ctx, old.Code, caio.ID); err != ErrInviteInvalid {
		t.Fatalf("expired invite: %v", err)
	}
	if members, _ := store.Members(ctx, g.ID); len(members) != 3 || members[0].Role != RoleOwner || members[1].Role != RoleAdmin {
		t.Fatalf("members: %+v", members)
	}

	// Channel messages, unread counts, deletion cascade.
	avisos, err := store.CreateChannel(ctx, g.ID, "Avisos Gerais", "Só coisas importantes", "text")
	if err != nil || avisos.Name != "avisos-gerais" || avisos.Position != 1 {
		t.Fatalf("create channel: %+v %v", avisos, err)
	}
	for i := 0; i < 3; i++ {
		if _, err := msgs.SendToChannel(ctx, ana.ID, avisos.ID, fmt.Sprintf("aviso %d", i), nil); err != nil {
			t.Fatal(err)
		}
	}
	photo, err := msgs.SendToChannel(ctx, bia.ID, avisos.ID, "", &messages.Attachment{FileName: "f.png", ContentType: "image/png", Name: "f.png", Size: 9, Width: 1, Height: 1})
	if err != nil || photo.ChannelID != avisos.ID || photo.RecipientID != "" {
		t.Fatalf("channel photo: %+v %v", photo, err)
	}
	unread, _ := msgs.ChannelUnread(ctx, caio.ID, []string{geral.ID, avisos.ID})
	if unread[avisos.ID] != 4 || unread[geral.ID] != 0 {
		t.Fatalf("caio unread: %v", unread)
	}
	if mine, _ := msgs.ChannelUnread(ctx, ana.ID, []string{avisos.ID}); mine[avisos.ID] != 1 {
		t.Fatalf("own messages counted as unread: %v", mine)
	}
	msgs.MarkChannelRead(ctx, caio.ID, avisos.ID)
	if after, _ := msgs.ChannelUnread(ctx, caio.ID, []string{avisos.ID}); after[avisos.ID] != 0 {
		t.Fatalf("after read: %v", after)
	}
	if hist, _ := msgs.ChannelHistory(ctx, avisos.ID, 0, 2); len(hist) != 2 || hist[1].ID != photo.ID {
		t.Fatalf("history: %+v", hist)
	}
	if convs, _ := msgs.Conversations(ctx, ana.ID); len(convs) != 0 {
		t.Fatalf("channel messages leaked into direct conversations: %+v", convs)
	}
	if edited, err := msgs.Edit(ctx, ana.ID, photo.ID-1, "corrigido"); err != nil || edited.ChannelID != avisos.ID {
		t.Fatalf("edit channel message: %v", err)
	}
	files, err := store.DeleteChannel(ctx, avisos.ID)
	if err != nil || len(files) != 1 || files[0] != "f.png" {
		t.Fatalf("delete channel: %v %v", files, err)
	}
	if _, err := msgs.Get(ctx, photo.ID); err != messages.ErrNotFound {
		t.Fatalf("channel messages not deleted: %v", err)
	}

	voice, err := store.CreateChannel(ctx, g.ID, "Sala de Reunião", "", "voice")
	if err != nil || voice.Kind != "voice" || voice.Position != 0 {
		t.Fatalf("voice channel: %+v %v", voice, err)
	}
	if _, err := store.CreateChannel(ctx, g.ID, "x", "", "video"); err != ErrInvalid {
		t.Fatalf("bad kind: %v", err)
	}
	if all, _ := store.Channels(ctx, g.ID); all[0].Kind != "text" || all[len(all)-1].Kind != "voice" {
		t.Fatalf("text channels should come first: %+v", all)
	}
	if _, err := store.DeleteChannel(ctx, voice.ID); err != nil {
		t.Fatalf("delete voice channel: %v", err)
	}
	if list, _ := store.ListForUser(ctx, caio.ID); len(list) != 1 || list[0].Role != RoleMember {
		t.Fatalf("list: %+v", list)
	}
	if old, err := store.SetIcon(ctx, g.ID, "/api/avatars/a.png"); err != nil || old != "" {
		t.Fatalf("set icon: %q %v", old, err)
	}
	if old, err := store.SetIcon(ctx, g.ID, "/api/avatars/b.png"); err != nil || old != "/api/avatars/a.png" {
		t.Fatalf("replace icon: %q %v", old, err)
	}
	if got, _ := store.Get(ctx, g.ID, ana.ID); got.Icon != "/api/avatars/b.png" {
		t.Fatalf("icon not saved: %q", got.Icon)
	}
	if err := store.Delete(ctx, g.ID); err != nil {
		t.Fatal(err)
	}
	if list, _ := store.ListForUser(ctx, caio.ID); len(list) != 0 {
		t.Fatalf("deleted server still listed: %+v", list)
	}
}
