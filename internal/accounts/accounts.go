package accounts

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/mail"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/argon2"
)

var ErrInvalid = errors.New("invalid account data")
var ErrConflict = errors.New("email or tag already exists")
var ErrUnauthorized = errors.New("invalid credentials")
var tagPattern = regexp.MustCompile(`^[a-z0-9_]{3,32}$`)

type User struct {
	ID            string `json:"id"`
	Avatar        string `json:"avatar"`
	Username      string `json:"username"`
	Email         string `json:"email"`
	UserTag       string `json:"userTag"`
	Role          string `json:"role"`
	AccountStatus string `json:"accountStatus"`
	Status        string `json:"status"`
}

type Contact struct {
	ID       string `json:"id"`
	Avatar   string `json:"avatar"`
	Username string `json:"username"`
	UserTag  string `json:"userTag"`
	Status   string `json:"status"`
}

type CreateInput struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	UserTag  string `json:"userTag"`
	Password string `json:"password"`
}

type Store struct{ DB *sql.DB }

func (s Store) Migrate(ctx context.Context) error {
	_, err := s.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS users (
		id UUID PRIMARY KEY, avatar TEXT NOT NULL DEFAULT '', username VARCHAR(80) NOT NULL,
		email VARCHAR(254) NOT NULL UNIQUE, user_tag VARCHAR(32) NOT NULL UNIQUE,
		password_hash TEXT NOT NULL, role VARCHAR(16) NOT NULL CHECK (role IN ('master','user')),
		account_status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','blocked')),
		status VARCHAR(16) NOT NULL DEFAULT 'offline' CHECK (status IN ('online','away','busy','offline')),
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);
	CREATE TABLE IF NOT EXISTS user_sessions (
		token_hash BYTEA PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		expires_at TIMESTAMPTZ NOT NULL
	);
	CREATE UNIQUE INDEX IF NOT EXISTS users_one_master_idx ON users (role) WHERE role='master';
	CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx ON user_sessions(user_id);`)
	return err
}

func normalize(in CreateInput) (CreateInput, error) {
	in.Username = strings.TrimSpace(in.Username)
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))
	in.UserTag = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(in.UserTag), "@"))
	address, err := mail.ParseAddress(in.Email)
	if err != nil || address.Address != in.Email || len(in.Email) > 254 || !tagPattern.MatchString(in.UserTag) || len([]rune(in.Username)) < 2 || len([]rune(in.Username)) > 80 || len(in.Password) < 12 || len(in.Password) > 1024 {
		return in, ErrInvalid
	}
	return in, nil
}

func hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(password), salt, 2, 19*1024, 1, 32)
	return fmt.Sprintf("$argon2id$v=19$m=19456,t=2,p=1$%s$%s", base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(hash)), nil
}

func verifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" || parts[3] != "m=19456,t=2,p=1" {
		return false
	}
	salt, e1 := base64.RawStdEncoding.DecodeString(parts[4])
	want, e2 := base64.RawStdEncoding.DecodeString(parts[5])
	if e1 != nil || e2 != nil || len(salt) != 16 || len(want) != 32 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, 2, 19*1024, 1, 32)
	return subtle.ConstantTimeCompare(got, want) == 1
}

func (s Store) Create(ctx context.Context, input CreateInput, role string) (User, error) {
	input, err := normalize(input)
	if err != nil || (role != "master" && role != "user") {
		return User{}, ErrInvalid
	}
	hash, err := hashPassword(input.Password)
	if err != nil {
		return User{}, err
	}
	u := User{ID: uuid.NewString(), Avatar: "", Username: input.Username, Email: input.Email, UserTag: input.UserTag, Role: role, AccountStatus: "active", Status: "offline"}
	_, err = s.DB.ExecContext(ctx, `INSERT INTO users (id,avatar,username,email,user_tag,password_hash,role) VALUES ($1,$2,$3,$4,$5,$6,$7)`, u.ID, u.Avatar, u.Username, u.Email, u.UserTag, hash, u.Role)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") {
			return User{}, ErrConflict
		}
		return User{}, err
	}
	return u, nil
}

const userColumns = `id,avatar,username,email,user_tag,role,account_status,status`

func scanUser(row interface{ Scan(...any) error }) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Avatar, &u.Username, &u.Email, &u.UserTag, &u.Role, &u.AccountStatus, &u.Status)
	return u, err
}

func (s Store) HasMaster(ctx context.Context) (bool, error) {
	var exists bool
	err := s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE role='master')`).Scan(&exists)
	return exists, err
}

func (s Store) Login(ctx context.Context, identifier, password string) (User, string, error) {
	identifier = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(identifier, "@")))
	var hash string
	var u User
	err := s.DB.QueryRowContext(ctx, `SELECT `+userColumns+`,password_hash FROM users WHERE email=$1 OR user_tag=$1`, identifier).Scan(&u.ID, &u.Avatar, &u.Username, &u.Email, &u.UserTag, &u.Role, &u.AccountStatus, &u.Status, &hash)
	if err != nil || !verifyPassword(hash, password) || u.AccountStatus != "active" {
		return User{}, "", ErrUnauthorized
	}
	tokenBytes := make([]byte, 32)
	if _, err = rand.Read(tokenBytes); err != nil {
		return User{}, "", err
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	digest := sha256.Sum256([]byte(token))
	_, err = s.DB.ExecContext(ctx, `INSERT INTO user_sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)`, digest[:], u.ID, time.Now().Add(7*24*time.Hour))
	return u, token, err
}

func (s Store) Session(ctx context.Context, token string) (User, error) {
	digest := sha256.Sum256([]byte(token))
	u, err := scanUser(s.DB.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users u JOIN user_sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.account_status='active'`, digest[:]))
	if err != nil {
		return User{}, ErrUnauthorized
	}
	return u, nil
}

func (s Store) Logout(ctx context.Context, token string) error {
	digest := sha256.Sum256([]byte(token))
	_, err := s.DB.ExecContext(ctx, `DELETE FROM user_sessions WHERE token_hash=$1`, digest[:])
	return err
}

func (s Store) List(ctx context.Context) ([]User, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+userColumns+` FROM users ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

func (s Store) ListContacts(ctx context.Context, currentID string) ([]Contact, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id,avatar,username,user_tag,status FROM users WHERE account_status='active' AND id<>$1 ORDER BY username,user_tag`, currentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	contacts := []Contact{}
	for rows.Next() {
		var contact Contact
		if err := rows.Scan(&contact.ID, &contact.Avatar, &contact.Username, &contact.UserTag, &contact.Status); err != nil {
			return nil, err
		}
		contacts = append(contacts, contact)
	}
	return contacts, rows.Err()
}

// Contact returns an active user's public profile.
func (s Store) Contact(ctx context.Context, id string) (Contact, error) {
	var c Contact
	err := s.DB.QueryRowContext(ctx, `SELECT id,avatar,username,user_tag,status FROM users WHERE id=$1 AND account_status='active'`, id).Scan(&c.ID, &c.Avatar, &c.Username, &c.UserTag, &c.Status)
	return c, err
}

func (s Store) SetAccountStatus(ctx context.Context, id, status string) error {
	if status != "active" && status != "blocked" {
		return ErrInvalid
	}
	result, err := s.DB.ExecContext(ctx, `UPDATE users SET account_status=$1 WHERE id=$2 AND role!='master'`, status, id)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return sql.ErrNoRows
	}
	if status == "blocked" {
		_, err = s.DB.ExecContext(ctx, `DELETE FROM user_sessions WHERE user_id=$1`, id)
	}
	return err
}

func (s Store) SetProfile(ctx context.Context, id, status string) (User, error) {
	if status != "online" && status != "away" && status != "busy" && status != "offline" {
		return User{}, ErrInvalid
	}
	return scanUser(s.DB.QueryRowContext(ctx, `UPDATE users SET status=$1 WHERE id=$2 RETURNING `+userColumns, status, id))
}

func (s Store) SetAvatar(ctx context.Context, id, path string) (User, error) {
	return scanUser(s.DB.QueryRowContext(ctx, `UPDATE users SET avatar=$1 WHERE id=$2 RETURNING `+userColumns, path, id))
}

func (s Store) ChangePassword(ctx context.Context, id, current, next string) error {
	if len(next) < 12 || len(next) > 1024 {
		return ErrInvalid
	}
	var stored string
	if err := s.DB.QueryRowContext(ctx, `SELECT password_hash FROM users WHERE id=$1`, id).Scan(&stored); err != nil {
		return ErrUnauthorized
	}
	if !verifyPassword(stored, current) {
		return ErrUnauthorized
	}
	hash, err := hashPassword(next)
	if err != nil {
		return err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE users SET password_hash=$1 WHERE id=$2`, hash, id); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM user_sessions WHERE user_id=$1`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// ResetPassword is for a trusted local administrator command, not an HTTP endpoint.
func (s Store) ResetPassword(ctx context.Context, tag, next string) error {
	if len(next) < 12 || len(next) > 1024 {
		return ErrInvalid
	}
	hash, err := hashPassword(next)
	if err != nil {
		return err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var id string
	err = tx.QueryRowContext(ctx, `UPDATE users SET password_hash=$1 WHERE user_tag=$2 RETURNING id`, hash, strings.ToLower(strings.TrimPrefix(tag, "@"))).Scan(&id)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM user_sessions WHERE user_id=$1`, id); err != nil {
		return err
	}
	return tx.Commit()
}
