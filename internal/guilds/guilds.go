// Package guilds stores servers ("servidores" in the UI): members with
// roles, text channels and invite links. Messages live in package messages.
package guilds

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"math/big"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
)

var ErrInvalid = errors.New("invalid data")
var ErrNotFound = errors.New("not found")
var ErrForbidden = errors.New("not allowed")
var ErrLastChannel = errors.New("a server needs at least one channel")
var ErrInviteInvalid = errors.New("invite expired or used up")

// Roles, from most to least powerful.
const (
	RoleOwner  = "owner"
	RoleAdmin  = "admin"
	RoleMember = "member"
)

// Rank orders roles so permissions can be compared.
func Rank(role string) int {
	switch role {
	case RoleOwner:
		return 3
	case RoleAdmin:
		return 2
	case RoleMember:
		return 1
	}
	return 0
}

type Guild struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Icon      string    `json:"icon"`
	OwnerID   string    `json:"ownerId"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"createdAt"`
}

type Channel struct {
	ID       string `json:"id"`
	GuildID  string `json:"guildId"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Topic    string `json:"topic"`
	Position int    `json:"position"`
}

type Member struct {
	UserID   string    `json:"userId"`
	Username string    `json:"username"`
	UserTag  string    `json:"userTag"`
	Avatar   string    `json:"avatar"`
	Status   string    `json:"status"`
	Role     string    `json:"role"`
	JoinedAt time.Time `json:"joinedAt"`
}

type Invite struct {
	Code      string     `json:"code"`
	GuildID   string     `json:"guildId"`
	ExpiresAt *time.Time `json:"expiresAt"`
	MaxUses   int        `json:"maxUses"`
	Uses      int        `json:"uses"`
}

type InvitePreview struct {
	Code        string `json:"code"`
	GuildID     string `json:"guildId"`
	GuildName   string `json:"guildName"`
	GuildIcon   string `json:"guildIcon"`
	MemberCount int    `json:"memberCount"`
	Member      bool   `json:"member"`
}

type Store struct{ DB *sql.DB }

func (s Store) Migrate(ctx context.Context) error {
	_, err := s.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS guilds (
		id UUID PRIMARY KEY, name VARCHAR(60) NOT NULL, icon TEXT NOT NULL DEFAULT '',
		owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);
	CREATE TABLE IF NOT EXISTS guild_members (
		guild_id UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
		user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		role VARCHAR(16) NOT NULL CHECK (role IN ('owner','admin','member')),
		joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		PRIMARY KEY (guild_id, user_id)
	);
	CREATE INDEX IF NOT EXISTS guild_members_user_idx ON guild_members (user_id);
	CREATE TABLE IF NOT EXISTS channels (
		id UUID PRIMARY KEY,
		guild_id UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
		name VARCHAR(40) NOT NULL, kind VARCHAR(8) NOT NULL DEFAULT 'text' CHECK (kind IN ('text','voice')),
		topic VARCHAR(200) NOT NULL DEFAULT '', position INT NOT NULL DEFAULT 0,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);
	CREATE INDEX IF NOT EXISTS channels_guild_idx ON channels (guild_id, position);
	CREATE TABLE IF NOT EXISTS guild_invites (
		code VARCHAR(16) PRIMARY KEY,
		guild_id UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
		created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		expires_at TIMESTAMPTZ, max_uses INT NOT NULL DEFAULT 0, uses INT NOT NULL DEFAULT 0,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);
	-- Channel messages and read markers go away with their channel.
	DO $$ BEGIN
		IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='direct_messages_channel_fk') THEN
			ALTER TABLE direct_messages ADD CONSTRAINT direct_messages_channel_fk FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE;
		END IF;
		IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='channel_reads_channel_fk') THEN
			ALTER TABLE channel_reads ADD CONSTRAINT channel_reads_channel_fk FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE;
		END IF;
	END $$;`)
	return err
}

// NormalizeGuildName trims and validates a server name.
func NormalizeGuildName(name string) (string, error) {
	name = strings.Join(strings.Fields(name), " ")
	if n := utf8.RuneCountInString(name); n < 2 || n > 60 {
		return "", ErrInvalid
	}
	return name, nil
}

// NormalizeChannelName turns "Bate Papo!" into "bate-papo", like Discord.
func NormalizeChannelName(name string) (string, error) {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_':
			b.WriteRune(r)
			dash = false
		case (unicode.IsSpace(r) || r == '-') && b.Len() > 0 && !dash:
			b.WriteRune('-')
			dash = true
		}
	}
	out := strings.TrimRight(b.String(), "-")
	if n := utf8.RuneCountInString(out); n < 1 || n > 40 {
		return "", ErrInvalid
	}
	return out, nil
}

func normalizeTopic(topic string) (string, error) {
	topic = strings.TrimSpace(topic)
	if utf8.RuneCountInString(topic) > 200 {
		return "", ErrInvalid
	}
	return topic, nil
}

// Create makes a server owned by ownerID with a default #geral channel.
func (s Store) Create(ctx context.Context, ownerID, name string) (Guild, error) {
	name, err := NormalizeGuildName(name)
	if err != nil {
		return Guild{}, err
	}
	g := Guild{ID: uuid.NewString(), Name: name, OwnerID: ownerID, Role: RoleOwner}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Guild{}, err
	}
	defer tx.Rollback()
	if err = tx.QueryRowContext(ctx, `INSERT INTO guilds (id,name,owner_id) VALUES ($1,$2,$3) RETURNING created_at`, g.ID, g.Name, ownerID).Scan(&g.CreatedAt); err != nil {
		return Guild{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO guild_members (guild_id,user_id,role) VALUES ($1,$2,'owner')`, g.ID, ownerID); err != nil {
		return Guild{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO channels (id,guild_id,name,position) VALUES ($1,$2,'geral',0)`, uuid.NewString(), g.ID); err != nil {
		return Guild{}, err
	}
	return g, tx.Commit()
}

// ListForUser returns the servers the user belongs to, with their role.
func (s Store) ListForUser(ctx context.Context, userID string) ([]Guild, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT g.id,g.name,g.icon,g.owner_id,m.role,g.created_at FROM guilds g
		JOIN guild_members m ON m.guild_id=g.id AND m.user_id=$1 ORDER BY m.joined_at, g.created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Guild{}
	for rows.Next() {
		var g Guild
		if err := rows.Scan(&g.ID, &g.Name, &g.Icon, &g.OwnerID, &g.Role, &g.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, g)
	}
	return list, rows.Err()
}

// Role returns the user's role in the server, or ErrNotFound if not a member.
func (s Store) Role(ctx context.Context, guildID, userID string) (string, error) {
	var role string
	err := s.DB.QueryRowContext(ctx, `SELECT role FROM guild_members WHERE guild_id=$1 AND user_id=$2`, guildID, userID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return role, err
}

// Get returns a server as seen by a member.
func (s Store) Get(ctx context.Context, guildID, userID string) (Guild, error) {
	var g Guild
	err := s.DB.QueryRowContext(ctx, `SELECT g.id,g.name,g.icon,g.owner_id,m.role,g.created_at FROM guilds g
		JOIN guild_members m ON m.guild_id=g.id AND m.user_id=$2 WHERE g.id=$1`, guildID, userID).Scan(&g.ID, &g.Name, &g.Icon, &g.OwnerID, &g.Role, &g.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Guild{}, ErrNotFound
	}
	return g, err
}

func (s Store) Rename(ctx context.Context, guildID, name string) error {
	name, err := NormalizeGuildName(name)
	if err != nil {
		return err
	}
	_, err = s.DB.ExecContext(ctx, `UPDATE guilds SET name=$2 WHERE id=$1`, guildID, name)
	return err
}

// SetIcon changes the server image and returns the previous one, to remove from disk.
func (s Store) SetIcon(ctx context.Context, guildID, icon string) (string, error) {
	var old string
	err := s.DB.QueryRowContext(ctx, `UPDATE guilds g SET icon=$2 FROM (SELECT icon FROM guilds WHERE id=$1 FOR UPDATE) prev
		WHERE g.id=$1 RETURNING prev.icon`, guildID, icon).Scan(&old)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return old, err
}

func (s Store) Delete(ctx context.Context, guildID string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM guilds WHERE id=$1`, guildID)
	return err
}

// Channels lists a server's channels in display order.
func (s Store) Channels(ctx context.Context, guildID string) ([]Channel, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id,guild_id,name,kind,topic,position FROM channels WHERE guild_id=$1 ORDER BY kind, position, created_at`, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Channel{}
	for rows.Next() {
		var c Channel
		if err := rows.Scan(&c.ID, &c.GuildID, &c.Name, &c.Kind, &c.Topic, &c.Position); err != nil {
			return nil, err
		}
		list = append(list, c)
	}
	return list, rows.Err()
}

// Channel returns one channel; ErrNotFound if it does not exist.
func (s Store) Channel(ctx context.Context, channelID string) (Channel, error) {
	var c Channel
	err := s.DB.QueryRowContext(ctx, `SELECT id,guild_id,name,kind,topic,position FROM channels WHERE id=$1`, channelID).Scan(&c.ID, &c.GuildID, &c.Name, &c.Kind, &c.Topic, &c.Position)
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	return c, err
}

// CreateChannel adds a text or voice channel at the end of its group.
func (s Store) CreateChannel(ctx context.Context, guildID, name, topic, kind string) (Channel, error) {
	if kind != "text" && kind != "voice" {
		return Channel{}, ErrInvalid
	}
	name, err := NormalizeChannelName(name)
	if err != nil {
		return Channel{}, err
	}
	if topic, err = normalizeTopic(topic); err != nil {
		return Channel{}, err
	}
	c := Channel{ID: uuid.NewString(), GuildID: guildID, Name: name, Kind: kind, Topic: topic}
	err = s.DB.QueryRowContext(ctx, `INSERT INTO channels (id,guild_id,name,kind,topic,position)
		VALUES ($1,$2,$3,$5::varchar,$4,(SELECT COALESCE(MAX(position),-1)+1 FROM channels WHERE guild_id=$2 AND kind=$5::varchar)) RETURNING position`, c.ID, guildID, name, topic, kind).Scan(&c.Position)
	return c, err
}

func (s Store) UpdateChannel(ctx context.Context, channelID, name, topic string) (Channel, error) {
	name, err := NormalizeChannelName(name)
	if err != nil {
		return Channel{}, err
	}
	if topic, err = normalizeTopic(topic); err != nil {
		return Channel{}, err
	}
	var c Channel
	err = s.DB.QueryRowContext(ctx, `UPDATE channels SET name=$2, topic=$3 WHERE id=$1 RETURNING id,guild_id,name,kind,topic,position`, channelID, name, topic).
		Scan(&c.ID, &c.GuildID, &c.Name, &c.Kind, &c.Topic, &c.Position)
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	return c, err
}

// DeleteChannel removes a channel and its messages, keeping at least one text channel.
// Voice channels can always be deleted.
// It returns the attachment files the caller should remove from disk.
func (s Store) DeleteChannel(ctx context.Context, channelID string) ([]string, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var guildID, kind string
	if err := tx.QueryRowContext(ctx, `SELECT guild_id, kind FROM channels WHERE id=$1 FOR UPDATE`, channelID).Scan(&guildID, &kind); err != nil {
		return nil, ErrNotFound
	}
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM channels WHERE guild_id=$1 AND kind='text'`, guildID).Scan(&count); err != nil {
		return nil, err
	}
	if kind == "text" && count <= 1 {
		return nil, ErrLastChannel
	}
	files, err := collect(tx.QueryContext(ctx, `SELECT attachment_name FROM direct_messages WHERE channel_id=$1 AND attachment_name IS NOT NULL`, channelID))
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM channels WHERE id=$1`, channelID); err != nil {
		return nil, err
	}
	return files, tx.Commit()
}

// AttachmentFiles lists every attachment stored in a server, to clean up after deleting it.
func (s Store) AttachmentFiles(ctx context.Context, guildID string) ([]string, error) {
	return collect(s.DB.QueryContext(ctx, `SELECT m.attachment_name FROM direct_messages m JOIN channels c ON c.id=m.channel_id
		WHERE c.guild_id=$1 AND m.attachment_name IS NOT NULL`, guildID))
}

func collect(rows *sql.Rows, err error) ([]string, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []string{}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		list = append(list, v)
	}
	return list, rows.Err()
}

// Members lists the server's active members with their role.
func (s Store) Members(ctx context.Context, guildID string) ([]Member, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT u.id,u.username,u.user_tag,u.avatar,u.status,m.role,m.joined_at FROM guild_members m
		JOIN users u ON u.id=m.user_id AND u.account_status='active'
		WHERE m.guild_id=$1 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.username`, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Member{}
	for rows.Next() {
		var m Member
		if err := rows.Scan(&m.UserID, &m.Username, &m.UserTag, &m.Avatar, &m.Status, &m.Role, &m.JoinedAt); err != nil {
			return nil, err
		}
		list = append(list, m)
	}
	return list, rows.Err()
}

// MemberIDs lists the user ids of a server, for realtime events.
func (s Store) MemberIDs(ctx context.Context, guildID string) ([]string, error) {
	return collect(s.DB.QueryContext(ctx, `SELECT user_id FROM guild_members WHERE guild_id=$1`, guildID))
}

// AddMember adds an active user as a member; adding an existing member is not an error.
func (s Store) AddMember(ctx context.Context, guildID, userID string) (bool, error) {
	res, err := s.DB.ExecContext(ctx, `INSERT INTO guild_members (guild_id,user_id,role)
		SELECT $1,id,'member' FROM users WHERE id=$2 AND account_status='active'
		ON CONFLICT DO NOTHING`, guildID, userID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		if _, err := s.Role(ctx, guildID, userID); err == nil {
			return false, nil
		}
		return false, ErrNotFound
	}
	return true, nil
}

// RemoveMember removes a member; the owner cannot be removed.
func (s Store) RemoveMember(ctx context.Context, guildID, userID string) error {
	res, err := s.DB.ExecContext(ctx, `DELETE FROM guild_members WHERE guild_id=$1 AND user_id=$2 AND role<>'owner'`, guildID, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetRole makes a member an admin or a regular member.
func (s Store) SetRole(ctx context.Context, guildID, userID, role string) error {
	if role != RoleAdmin && role != RoleMember {
		return ErrInvalid
	}
	res, err := s.DB.ExecContext(ctx, `UPDATE guild_members SET role=$3 WHERE guild_id=$1 AND user_id=$2 AND role<>'owner'`, guildID, userID, role)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

const inviteAlphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func newInviteCode() (string, error) {
	b := make([]byte, 10)
	for i := range b {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(inviteAlphabet))))
		if err != nil {
			return "", err
		}
		b[i] = inviteAlphabet[n.Int64()]
	}
	return string(b), nil
}

// CreateInvite makes an invite link. ttl 0 never expires; maxUses 0 is unlimited.
func (s Store) CreateInvite(ctx context.Context, guildID, createdBy string, ttl time.Duration, maxUses int) (Invite, error) {
	if ttl < 0 || ttl > 30*24*time.Hour || maxUses < 0 || maxUses > 1000 {
		return Invite{}, ErrInvalid
	}
	code, err := newInviteCode()
	if err != nil {
		return Invite{}, err
	}
	inv := Invite{Code: code, GuildID: guildID, MaxUses: maxUses}
	var expires sql.NullTime
	if ttl > 0 {
		t := time.Now().Add(ttl).UTC()
		expires = sql.NullTime{Time: t, Valid: true}
		inv.ExpiresAt = &t
	}
	_, err = s.DB.ExecContext(ctx, `INSERT INTO guild_invites (code,guild_id,created_by,expires_at,max_uses) VALUES ($1,$2,$3,$4,$5)`, code, guildID, createdBy, expires, maxUses)
	return inv, err
}

const validInviteSQL = `(i.expires_at IS NULL OR i.expires_at > NOW()) AND (i.max_uses = 0 OR i.uses < i.max_uses)`

// Preview shows what server an invite leads to, if it is still valid.
func (s Store) Preview(ctx context.Context, code, userID string) (InvitePreview, error) {
	var p InvitePreview
	err := s.DB.QueryRowContext(ctx, `SELECT i.code,g.id,g.name,g.icon,
		(SELECT COUNT(*) FROM guild_members WHERE guild_id=g.id),
		EXISTS(SELECT 1 FROM guild_members WHERE guild_id=g.id AND user_id=$2)
		FROM guild_invites i JOIN guilds g ON g.id=i.guild_id WHERE i.code=$1 AND `+validInviteSQL, code, userID).
		Scan(&p.Code, &p.GuildID, &p.GuildName, &p.GuildIcon, &p.MemberCount, &p.Member)
	if errors.Is(err, sql.ErrNoRows) {
		return InvitePreview{}, ErrInviteInvalid
	}
	return p, err
}

// Accept joins the user to the invite's server and counts a use (not for existing members).
func (s Store) Accept(ctx context.Context, code, userID string) (string, bool, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback()
	var guildID string
	err = tx.QueryRowContext(ctx, `SELECT i.guild_id FROM guild_invites i WHERE i.code=$1 AND `+validInviteSQL+` FOR UPDATE`, code).Scan(&guildID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, ErrInviteInvalid
	}
	if err != nil {
		return "", false, err
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO guild_members (guild_id,user_id,role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING`, guildID, userID)
	if err != nil {
		return "", false, err
	}
	joined, _ := res.RowsAffected()
	if joined > 0 {
		if _, err := tx.ExecContext(ctx, `UPDATE guild_invites SET uses=uses+1 WHERE code=$1`, code); err != nil {
			return "", false, err
		}
	}
	return guildID, joined > 0, tx.Commit()
}
