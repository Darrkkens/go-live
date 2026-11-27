package messages

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Darrkkens/go-live/internal/accounts"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

func TestNormalizeBody(t *testing.T) {
	if got, err := NormalizeBody("  oi\r\ntudo bem?  "); err != nil || got != "oi\ntudo bem?" {
		t.Fatalf("got %q %v", got, err)
	}
	for _, bad := range []string{"", "   \n ", strings.Repeat("a", MaxBodyRunes+1), "\xff"} {
		if _, err := NormalizeBody(bad); err != ErrInvalid {
			t.Fatalf("expected invalid for %q", bad)
		}
	}
	if _, err := NormalizeBody(strings.Repeat("é", MaxBodyRunes)); err != nil {
		t.Fatal(err)
	}
}

func TestMessageFlow(t *testing.T) {
	ctx := context.Background()
	container, err := postgres.Run(ctx, "postgres:latest", postgres.WithDatabase("go_live"), postgres.WithUsername("test"), postgres.WithPassword("test"), testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(60*time.Second)))
	if err != nil {
		t.Skipf("Docker unavailable: %v", err)
	}
	defer container.Terminate(ctx)
	host, _ := container.Host(ctx)
	port, err := container.MappedPort(ctx, "5432/tcp")
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("pgx", fmt.Sprintf("postgres://test:test@%s:%s/go_live?sslmode=disable", host, port.Port()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	users := accounts.Store{DB: db}
	store := Store{DB: db}
	if err := users.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	ana, _ := users.Create(ctx, accounts.CreateInput{Username: "Ana", Email: "ana@example.com", UserTag: "ana", Password: "long secure password"}, "user")
	bia, _ := users.Create(ctx, accounts.CreateInput{Username: "Bia", Email: "bia@example.com", UserTag: "bia", Password: "long secure password"}, "user")
	caio, _ := users.Create(ctx, accounts.CreateInput{Username: "Caio", Email: "caio@example.com", UserTag: "caio", Password: "long secure password"}, "user")

	if _, err := store.Send(ctx, ana.ID, ana.ID, "eu"); err != ErrRecipient {
		t.Fatalf("self message: %v", err)
	}
	for i := 1; i <= 5; i++ {
		from, to := ana.ID, bia.ID
		if i%2 == 0 {
			from, to = bia.ID, ana.ID
		}
		if _, err := store.Send(ctx, from, to, fmt.Sprintf("msg %d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.Send(ctx, caio.ID, ana.ID, "oi Ana"); err != nil {
		t.Fatal(err)
	}

	all, err := store.History(ctx, bia.ID, ana.ID, 0, 0)
	if err != nil || len(all) != 5 || all[0].Body != "msg 1" || all[4].Body != "msg 5" {
		t.Fatalf("history: %v %v", all, err)
	}
	page, err := store.History(ctx, ana.ID, bia.ID, all[3].ID, 2)
	if err != nil || len(page) != 2 || page[0].Body != "msg 2" || page[1].Body != "msg 3" {
		t.Fatalf("paged history: %v %v", page, err)
	}
	if other, _ := store.History(ctx, caio.ID, bia.ID, 0, 0); len(other) != 0 {
		t.Fatalf("unrelated history leaked: %v", other)
	}

	convs, err := store.Conversations(ctx, ana.ID)
	if err != nil || len(convs) != 2 {
		t.Fatalf("conversations: %v %v", convs, err)
	}
	unread := map[string]int{}
	for _, c := range convs {
		unread[c.ContactID] = c.Unread
	}
	if unread[bia.ID] != 2 || unread[caio.ID] != 1 {
		t.Fatalf("unread: %v", unread)
	}
	if _, n, err := store.MarkRead(ctx, ana.ID, bia.ID); err != nil || n != 2 {
		t.Fatalf("mark read: %d %v", n, err)
	}
	if _, n, _ := store.MarkRead(ctx, ana.ID, bia.ID); n != 0 {
		t.Fatalf("second mark read changed %d", n)
	}
	if after, _ := store.History(ctx, ana.ID, bia.ID, 0, 0); after[1].ReadAt == nil || after[0].ReadAt != nil {
		t.Fatalf("read flags: %+v", after)
	}

	img := &Attachment{FileName: "x.png", ContentType: "image/png", Name: "foto.png", Size: 100, Width: 10, Height: 20}
	doc, err := store.SendWithAttachment(ctx, ana.ID, bia.ID, "", &Attachment{FileName: "y.pdf", ContentType: "application/pdf", Name: "Relatório.pdf", Size: 2048})
	if err != nil || doc.Attachment.Kind != "file" || doc.Attachment.Name != "Relatório.pdf" || doc.Attachment.Size != 2048 || doc.Attachment.Width != 0 {
		t.Fatalf("document: %+v %v", doc.Attachment, err)
	}
	if _, err := store.SendWithAttachment(ctx, ana.ID, bia.ID, "", &Attachment{FileName: "z.png", ContentType: "image/png", Name: "z.png", Size: 1}); err != ErrInvalid {
		t.Fatalf("image without size accepted: %v", err)
	}
	photo, err := store.SendWithAttachment(ctx, ana.ID, bia.ID, "  ", img)
	if err != nil || photo.Body != "" || photo.Attachment == nil || photo.Attachment.Kind != "image" || photo.Attachment.URL != fmt.Sprintf("/api/messages/%d/attachment", photo.ID) {
		t.Fatalf("image without caption: %+v %v", photo, err)
	}
	if withCaption, err := store.SendWithAttachment(ctx, bia.ID, ana.ID, " legenda ", img); err != nil || withCaption.Body != "legenda" {
		t.Fatalf("caption: %+v %v", withCaption, err)
	}
	if _, err := store.SendWithAttachment(ctx, ana.ID, bia.ID, "", &Attachment{}); err != ErrInvalid {
		t.Fatalf("empty attachment: %v", err)
	}
	if a, err := store.Attachment(ctx, bia.ID, photo.ID); err != nil || a.FileName != "x.png" {
		t.Fatalf("recipient attachment: %v", err)
	}
	if _, err := store.Attachment(ctx, caio.ID, photo.ID); err != sql.ErrNoRows {
		t.Fatalf("outsider read attachment: %v", err)
	}
	if _, err := store.Attachment(ctx, ana.ID, all[0].ID); err != sql.ErrNoRows {
		t.Fatalf("text message has attachment: %v", err)
	}
	if convs, _ := store.Conversations(ctx, bia.ID); convs[0].LastMessage.Attachment == nil {
		t.Fatalf("conversation preview lost attachment: %+v", convs)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("migration not idempotent: %v", err)
	}

	edited, err := store.Edit(ctx, ana.ID, all[0].ID, "  msg 1 corrigida ")
	if err != nil || edited.Body != "msg 1 corrigida" || edited.EditedAt == nil {
		t.Fatalf("edit: %+v %v", edited, err)
	}
	if _, err := store.Edit(ctx, bia.ID, all[0].ID, "hack"); err != ErrNotFound {
		t.Fatalf("recipient edited: %v", err)
	}
	if _, err := store.Edit(ctx, ana.ID, all[0].ID, "   "); err != ErrInvalid {
		t.Fatalf("empty edit of text message: %v", err)
	}
	if cleared, err := store.Edit(ctx, ana.ID, photo.ID, "agora com legenda"); err != nil || cleared.Body != "agora com legenda" {
		t.Fatalf("caption edit: %v", err)
	}
	if cleared, err := store.Edit(ctx, ana.ID, photo.ID, ""); err != nil || cleared.Body != "" || cleared.Attachment == nil {
		t.Fatalf("caption removal: %v", err)
	}
	if _, _, err := store.Delete(ctx, bia.ID, photo.ID); err != ErrNotFound {
		t.Fatalf("recipient deleted: %v", err)
	}
	deleted, file, err := store.Delete(ctx, ana.ID, photo.ID)
	if err != nil || file != "x.png" || deleted.DeletedAt == nil || deleted.Attachment != nil || deleted.Body != "" {
		t.Fatalf("delete: %+v %q %v", deleted, file, err)
	}
	if _, _, err := store.Delete(ctx, ana.ID, photo.ID); err != ErrNotFound {
		t.Fatalf("double delete: %v", err)
	}
	if _, err := store.Edit(ctx, ana.ID, photo.ID, "volta"); err != ErrNotFound {
		t.Fatalf("edited deleted message: %v", err)
	}
	if _, err := store.Attachment(ctx, bia.ID, photo.ID); err != sql.ErrNoRows {
		t.Fatalf("deleted attachment still served: %v", err)
	}
	old, _ := store.Send(ctx, ana.ID, bia.ID, "mensagem antiga")
	if _, err := db.ExecContext(ctx, `UPDATE direct_messages SET created_at=NOW()-interval '5 minutes 1 second' WHERE id=$1`, old.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Edit(ctx, ana.ID, old.ID, "tarde demais"); err != ErrExpired {
		t.Fatalf("edit after window: %v", err)
	}
	if _, _, err := store.Delete(ctx, ana.ID, old.ID); err != ErrExpired {
		t.Fatalf("delete after window: %v", err)
	}
	if _, err := store.Edit(ctx, bia.ID, old.ID, "x"); err != ErrNotFound {
		t.Fatalf("recipient on expired message: %v", err)
	}
	recent, _ := store.Send(ctx, ana.ID, bia.ID, "quase no limite")
	db.ExecContext(ctx, `UPDATE direct_messages SET created_at=NOW()-interval '4 minutes 50 seconds' WHERE id=$1`, recent.ID)
	if _, err := store.Edit(ctx, ana.ID, recent.ID, "ainda dá"); err != nil {
		t.Fatalf("edit inside window: %v", err)
	}

	unreadBefore := 0
	for _, c := range mustConversations(t, store, ctx, bia.ID) {
		if c.ContactID == ana.ID {
			unreadBefore = c.Unread
		}
	}
	toDelete, _ := store.Send(ctx, ana.ID, bia.ID, "vou apagar")
	store.Delete(ctx, ana.ID, toDelete.ID)
	for _, c := range mustConversations(t, store, ctx, bia.ID) {
		if c.ContactID == ana.ID && (c.Unread != unreadBefore || c.LastMessage.DeletedAt == nil) {
			t.Fatalf("deleted unread message still counted: %+v (before %d)", c, unreadBefore)
		}
	}

	if err := users.SetAccountStatus(ctx, caio.ID, "blocked"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Send(ctx, ana.ID, caio.ID, "oi"); err != ErrRecipient {
		t.Fatalf("blocked recipient: %v", err)
	}
	if convs, _ := store.Conversations(ctx, ana.ID); len(convs) != 1 || convs[0].ContactID != bia.ID || convs[0].Unread != 1 || convs[0].LastMessage.DeletedAt == nil {
		t.Fatalf("conversations after block: %+v", convs)
	}
}

func mustConversations(t *testing.T, store Store, ctx context.Context, userID string) []Conversation {
	t.Helper()
	list, err := store.Conversations(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	return list
}
