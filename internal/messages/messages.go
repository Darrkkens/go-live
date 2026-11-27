// Package messages stores one-to-one text messages between users.
package messages

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

const MaxBodyRunes = 4000
const DefaultPageSize = 50
const MaxPageSize = 100

var ErrInvalid = errors.New("invalid message")
var ErrRecipient = errors.New("recipient not available")

type Message struct {
	ID          int64      `json:"id"`
	SenderID    string     `json:"senderId"`
	RecipientID string     `json:"recipientId"`
	Body        string     `json:"body"`
	CreatedAt   time.Time  `json:"createdAt"`
	ReadAt      *time.Time `json:"readAt"`
}

type Conversation struct {
	ContactID   string  `json:"contactId"`
	LastMessage Message `json:"lastMessage"`
	Unread      int     `json:"unread"`
}

type Store struct{ DB *sql.DB }

func (s Store) Migrate(ctx context.Context) error {
	_, err := s.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS direct_messages (
		id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
		sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		read_at TIMESTAMPTZ,
		CHECK (sender_id <> recipient_id)
	);
	CREATE INDEX IF NOT EXISTS direct_messages_pair_idx ON direct_messages (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), id DESC);
	CREATE INDEX IF NOT EXISTS direct_messages_unread_idx ON direct_messages (recipient_id, sender_id) WHERE read_at IS NULL;`)
	return err
}

const columns = `id,sender_id,recipient_id,body,created_at,read_at`

func scanInto(row interface{ Scan(...any) error }, m *Message, extra ...any) error {
	var readAt sql.NullTime
	dest := append([]any{&m.ID, &m.SenderID, &m.RecipientID, &m.Body, &m.CreatedAt, &readAt}, extra...)
	if err := row.Scan(dest...); err != nil {
		return err
	}
	if readAt.Valid {
		v := readAt.Time
		m.ReadAt = &v
	}
	return nil
}

func scan(row interface{ Scan(...any) error }) (Message, error) {
	var m Message
	err := scanInto(row, &m)
	return m, err
}

// NormalizeBody trims surrounding whitespace and validates length.
func NormalizeBody(body string) (string, error) {
	body = strings.TrimSpace(strings.ReplaceAll(body, "\r\n", "\n"))
	if body == "" || !utf8.ValidString(body) || utf8.RuneCountInString(body) > MaxBodyRunes {
		return "", ErrInvalid
	}
	return body, nil
}

// Send stores a text message from sender to an active recipient.
func (s Store) Send(ctx context.Context, senderID, recipientID, body string) (Message, error) {
	body, err := NormalizeBody(body)
	if err != nil {
		return Message{}, err
	}
	if senderID == recipientID {
		return Message{}, ErrRecipient
	}
	m, err := scan(s.DB.QueryRowContext(ctx, `INSERT INTO direct_messages (sender_id,recipient_id,body)
		SELECT $1,id,$3 FROM users WHERE id=$2 AND account_status='active'
		RETURNING `+columns, senderID, recipientID, body))
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, ErrRecipient
	}
	return m, err
}

// History returns up to limit messages between two users, oldest first,
// with ids lower than before (0 means newest).
func (s Store) History(ctx context.Context, userID, contactID string, before int64, limit int) ([]Message, error) {
	if limit <= 0 || limit > MaxPageSize {
		limit = DefaultPageSize
	}
	query := `SELECT ` + columns + ` FROM direct_messages
		WHERE LEAST(sender_id, recipient_id)=LEAST($1::uuid,$2::uuid) AND GREATEST(sender_id, recipient_id)=GREATEST($1::uuid,$2::uuid)`
	args := []any{userID, contactID}
	if before > 0 {
		query += ` AND id<$3 ORDER BY id DESC LIMIT $4`
		args = append(args, before, limit)
	} else {
		query += ` ORDER BY id DESC LIMIT $3`
		args = append(args, limit)
	}
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Message{}
	for rows.Next() {
		m, err := scan(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, m)
	}
	for i, j := 0, len(list)-1; i < j; i, j = i+1, j-1 {
		list[i], list[j] = list[j], list[i]
	}
	return list, rows.Err()
}

// MarkRead marks every unread message from contact to user as read and
// returns the read timestamp and how many messages changed.
func (s Store) MarkRead(ctx context.Context, userID, contactID string) (time.Time, int64, error) {
	now := time.Now().UTC()
	result, err := s.DB.ExecContext(ctx, `UPDATE direct_messages SET read_at=$3 WHERE recipient_id=$1 AND sender_id=$2 AND read_at IS NULL`, userID, contactID, now)
	if err != nil {
		return now, 0, err
	}
	n, _ := result.RowsAffected()
	return now, n, nil
}

// Conversations returns the latest message and unread count for each
// active contact the user has exchanged messages with.
func (s Store) Conversations(ctx context.Context, userID string) ([]Conversation, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT DISTINCT ON (mine.other) mine.id,mine.sender_id,mine.recipient_id,mine.body,mine.created_at,mine.read_at,mine.other,
		(SELECT COUNT(*) FROM direct_messages u WHERE u.recipient_id=$1 AND u.sender_id=mine.other AND u.read_at IS NULL)
		FROM (SELECT m.*, CASE WHEN m.sender_id=$1 THEN m.recipient_id ELSE m.sender_id END AS other
			FROM direct_messages m WHERE m.sender_id=$1 OR m.recipient_id=$1) mine
		JOIN users ON users.id=mine.other AND users.account_status='active'
		ORDER BY mine.other, mine.id DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Conversation{}
	for rows.Next() {
		var c Conversation
		if err := scanInto(rows, &c.LastMessage, &c.ContactID, &c.Unread); err != nil {
			return nil, err
		}
		list = append(list, c)
	}
	return list, rows.Err()
}
