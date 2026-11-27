package accounts

import (
	"context"
	"database/sql"
	"fmt"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
	"time"
)

func TestPasswordHash(t *testing.T) {
	hash, err := hashPassword("a very long password")
	if err != nil {
		t.Fatal(err)
	}
	if hash == "a very long password" || !verifyPassword(hash, "a very long password") || verifyPassword(hash, "wrong") {
		t.Fatal("password verification failed")
	}
}

func TestAccountFlow(t *testing.T) {
	ctx := context.Background()
	container, err := postgres.Run(ctx, "postgres:latest", postgres.WithDatabase("go_live"), postgres.WithUsername("test"), postgres.WithPassword("test"), testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(60*time.Second)))
	if err != nil {
		t.Skipf("Docker unavailable: %v", err)
	}
	defer container.Terminate(ctx)
	host, err := container.Host(ctx)
	if err != nil {
		t.Fatal(err)
	}
	port, err := container.MappedPort(ctx, "5432/tcp")
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("pgx", fmt.Sprintf("postgres://test:test@%s:%s/go_live?sslmode=disable", host, port.Port()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := Store{DB: db}
	if err := store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	master, err := store.Create(ctx, CreateInput{Username: "Master", Email: "MASTER@example.com", UserTag: "@master", Password: "long secure password"}, "master")
	if err != nil {
		t.Fatal(err)
	}
	if master.Email != "master@example.com" || master.UserTag != "master" {
		t.Fatal(master)
	}
	if _, err := store.Create(ctx, CreateInput{Username: "Second", Email: "second@example.com", UserTag: "second", Password: "long secure password"}, "master"); err != ErrConflict {
		t.Fatalf("expected unique master, got %v", err)
	}
	user, err := store.Create(ctx, CreateInput{Username: "Ana", Email: "ana@example.com", UserTag: "@ana", Password: "another secure password"}, "user")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Create(ctx, CreateInput{Username: "Other", Email: "ana@example.com", UserTag: "other", Password: "another secure password"}, "user"); err != ErrConflict {
		t.Fatalf("expected duplicate email, got %v", err)
	}
	if _, _, err := store.Login(ctx, "@ana", "wrong password"); err != ErrUnauthorized {
		t.Fatalf("expected invalid login, got %v", err)
	}
	logged, token, err := store.Login(ctx, "ANA@example.com", "another secure password")
	if err != nil || logged.ID != user.ID {
		t.Fatalf("login: %v", err)
	}
	if current, err := store.Session(ctx, token); err != nil || current.ID != user.ID {
		t.Fatalf("session: %v", err)
	}
	if err := store.SetAccountStatus(ctx, user.ID, "blocked"); err != nil {
		t.Fatal(err)
	}
	contacts, err := store.ListContacts(ctx, master.ID)
	if err != nil || len(contacts) != 0 {
		t.Fatalf("blocked user visible to master: %v %v", contacts, err)
	}
	if _, err := store.Session(ctx, token); err != ErrUnauthorized {
		t.Fatalf("blocked session: %v", err)
	}
	if _, _, err := store.Login(ctx, "ana", "another secure password"); err != ErrUnauthorized {
		t.Fatalf("blocked login: %v", err)
	}
	if err := store.SetAccountStatus(ctx, master.ID, "blocked"); err != sql.ErrNoRows {
		t.Fatalf("master blocked: %v", err)
	}
	_, masterToken, err := store.Login(ctx, "@master", "long secure password")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ChangePassword(ctx, master.ID, "wrong", "new secure password"); err != ErrUnauthorized {
		t.Fatalf("wrong current password: %v", err)
	}
	if err := store.ChangePassword(ctx, master.ID, "long secure password", "new secure password"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Session(ctx, masterToken); err != ErrUnauthorized {
		t.Fatalf("old session still valid: %v", err)
	}
	if _, _, err := store.Login(ctx, "master@example.com", "new secure password"); err != nil {
		t.Fatal(err)
	}
	if err := store.ResetPassword(ctx, "@master", "reset secure password"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Login(ctx, "master", "new secure password"); err != ErrUnauthorized {
		t.Fatalf("old password still works: %v", err)
	}
	if _, _, err := store.Login(ctx, "master", "reset secure password"); err != nil {
		t.Fatal(err)
	}
}
