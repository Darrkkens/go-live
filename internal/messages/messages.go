// Package messages stores one-to-one text messages between users.
package messages

import (
	"context"
	"database/sql"
	"errors"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const MaxBodyRunes = 4000
const DefaultPageSize = 50
const MaxPageSize = 100

var ErrInvalid = errors.New("invalid message")
var ErrRecipient = errors.New("recipient not available")
var ErrNotFound = errors.New("message not found")
var ErrExpired = errors.New("edit window expired")

// ChangeWindow is how long after sending a message can be edited or deleted.
const ChangeWindow = 5 * time.Minute

// changeWindowSQL limits edits and deletions using the database clock.
const changeWindowSQL = `created_at > NOW() - make_interval(secs => 300)`

// changeError explains why a change matched no row: the message is not the
// user's (or is deleted), it is past the window, or otherwise the input was invalid.
func (s Store) changeError(ctx context.Context, userID string, messageID int64) error {
	var inWindow bool
	err := s.DB.QueryRowContext(ctx, `SELECT `+changeWindowSQL+` FROM direct_messages WHERE id=$1 AND sender_id=$2 AND deleted_at IS NULL`, messageID, userID).Scan(&inWindow)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return ErrNotFound
	case err != nil:
		return err
	case !inWindow:
		return ErrExpired
	default:
		return ErrInvalid
	}
}

type Message struct {
	ID          int64       `json:"id"`
	SenderID    string      `json:"senderId"`
	RecipientID string      `json:"recipientId"`
	Body        string      `json:"body"`
	Attachment  *Attachment `json:"attachment"`
	CreatedAt   time.Time   `json:"createdAt"`
	ReadAt      *time.Time  `json:"readAt"`
	EditedAt    *time.Time  `json:"editedAt"`
	DeletedAt   *time.Time  `json:"deletedAt"`
}

// Attachment is an image or document stored on disk; FileName never leaves the server.
type Attachment struct {
	FileName    string `json:"-"`
	Kind        string `json:"kind"`
	ContentType string `json:"contentType"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	Width       int    `json:"width,omitempty"`
	Height      int    `json:"height,omitempty"`
	URL         string `json:"url"`
}

func (a Attachment) valid() bool {
	if a.FileName == "" || a.ContentType == "" || a.Name == "" || a.Size < 1 {
		return false
	}
	if strings.HasPrefix(a.ContentType, "image/") {
		return a.Width > 0 && a.Height > 0
	}
	return a.Width == 0 && a.Height == 0
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
	CREATE INDEX IF NOT EXISTS direct_messages_unread_idx ON direct_messages (recipient_id, sender_id) WHERE read_at IS NULL;
	ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS attachment_name TEXT,
		ADD COLUMN IF NOT EXISTS attachment_type TEXT,
		ADD COLUMN IF NOT EXISTS attachment_width INT,
		ADD COLUMN IF NOT EXISTS attachment_height INT,
		ADD COLUMN IF NOT EXISTS attachment_original_name TEXT,
		ADD COLUMN IF NOT EXISTS attachment_size BIGINT,
		ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
		ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
	DO $$ BEGIN
		IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='direct_messages_content_v2_check') THEN
			ALTER TABLE direct_messages DROP CONSTRAINT IF EXISTS direct_messages_body_check;
			ALTER TABLE direct_messages DROP CONSTRAINT IF EXISTS direct_messages_content_check;
			ALTER TABLE direct_messages ADD CONSTRAINT direct_messages_content_v2_check CHECK (
				char_length(body) <= 4000 AND (deleted_at IS NOT NULL OR char_length(body) > 0 OR attachment_name IS NOT NULL));
		END IF;
	END $$;`)
	return err
}

const columns = `id,sender_id,recipient_id,body,created_at,read_at,attachment_name,attachment_type,attachment_width,attachment_height,attachment_original_name,attachment_size,edited_at,deleted_at`

func scanInto(row interface{ Scan(...any) error }, m *Message, extra ...any) error {
	var readAt, editedAt, deletedAt sql.NullTime
	var name, contentType, original sql.NullString
	var width, height, size sql.NullInt64
	dest := append([]any{&m.ID, &m.SenderID, &m.RecipientID, &m.Body, &m.CreatedAt, &readAt, &name, &contentType, &width, &height, &original, &size, &editedAt, &deletedAt}, extra...)
	if err := row.Scan(dest...); err != nil {
		return err
	}
	for _, t := range []struct {
		src sql.NullTime
		dst **time.Time
	}{{readAt, &m.ReadAt}, {editedAt, &m.EditedAt}, {deletedAt, &m.DeletedAt}} {
		if t.src.Valid {
			v := t.src.Time
			*t.dst = &v
		}
	}
	if name.Valid {
		a := &Attachment{FileName: name.String, Kind: "file", ContentType: contentType.String, Name: original.String, Size: size.Int64, Width: int(width.Int64), Height: int(height.Int64), URL: "/api/messages/" + strconv.FormatInt(m.ID, 10) + "/attachment"}
		if strings.HasPrefix(a.ContentType, "image/") {
			a.Kind = "image"
		}
		if a.Name == "" { // images sent before original names were stored
			a.Name = "imagem-" + strconv.FormatInt(m.ID, 10) + path.Ext(a.FileName)
		}
		m.Attachment = a
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
	return s.SendWithAttachment(ctx, senderID, recipientID, body, nil)
}

// SendWithAttachment stores a message that may carry an image or document;
// with an attachment the body is an optional caption.
func (s Store) SendWithAttachment(ctx context.Context, senderID, recipientID, body string, a *Attachment) (Message, error) {
	var err error
	if a == nil || strings.TrimSpace(body) != "" {
		if body, err = NormalizeBody(body); err != nil {
			return Message{}, err
		}
	} else {
		body = ""
	}
	if senderID == recipientID {
		return Message{}, ErrRecipient
	}
	var name, contentType, original sql.NullString
	var width, height, size sql.NullInt64
	if a != nil {
		if !a.valid() {
			return Message{}, ErrInvalid
		}
		name, contentType, original = sql.NullString{String: a.FileName, Valid: true}, sql.NullString{String: a.ContentType, Valid: true}, sql.NullString{String: a.Name, Valid: true}
		size = sql.NullInt64{Int64: a.Size, Valid: true}
		width, height = sql.NullInt64{Int64: int64(a.Width), Valid: a.Width > 0}, sql.NullInt64{Int64: int64(a.Height), Valid: a.Height > 0}
	}
	m, err := scan(s.DB.QueryRowContext(ctx, `INSERT INTO direct_messages (sender_id,recipient_id,body,attachment_name,attachment_type,attachment_width,attachment_height,attachment_original_name,attachment_size)
		SELECT $1,id,$3,$4,$5,$6,$7,$8,$9 FROM users WHERE id=$2 AND account_status='active'
		RETURNING `+columns, senderID, recipientID, body, name, contentType, width, height, original, size))
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

// Edit changes the text (or caption) of a message the user sent within ChangeWindow.
func (s Store) Edit(ctx context.Context, userID string, messageID int64, body string) (Message, error) {
	body = strings.TrimSpace(strings.ReplaceAll(body, "\r\n", "\n"))
	if !utf8.ValidString(body) || utf8.RuneCountInString(body) > MaxBodyRunes {
		return Message{}, ErrInvalid
	}
	m, err := scan(s.DB.QueryRowContext(ctx, `UPDATE direct_messages SET body=$3,
		edited_at=CASE WHEN body=$3 THEN edited_at ELSE NOW() END
		WHERE id=$1 AND sender_id=$2 AND deleted_at IS NULL AND ($3<>'' OR attachment_name IS NOT NULL) AND `+changeWindowSQL+`
		RETURNING `+columns, messageID, userID, body))
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, s.changeError(ctx, userID, messageID)
	}
	return m, err
}

// Delete removes a message the user sent within ChangeWindow for both people. The returned file
// name, if any, is the attachment the caller should remove from disk.
func (s Store) Delete(ctx context.Context, userID string, messageID int64) (Message, string, error) {
	var m Message
	var file sql.NullString
	err := scanInto(s.DB.QueryRowContext(ctx, `WITH old AS (
			SELECT id, attachment_name FROM direct_messages WHERE id=$1 AND sender_id=$2 AND deleted_at IS NULL AND `+changeWindowSQL+` FOR UPDATE
		)
		UPDATE direct_messages m SET body='', deleted_at=NOW(), edited_at=NULL, attachment_name=NULL, attachment_type=NULL,
			attachment_width=NULL, attachment_height=NULL, attachment_original_name=NULL, attachment_size=NULL
		FROM old WHERE m.id=old.id
		RETURNING m.id,m.sender_id,m.recipient_id,m.body,m.created_at,m.read_at,m.attachment_name,m.attachment_type,m.attachment_width,
			m.attachment_height,m.attachment_original_name,m.attachment_size,m.edited_at,m.deleted_at,old.attachment_name`, messageID, userID), &m, &file)
	if errors.Is(err, sql.ErrNoRows) {
		if cause := s.changeError(ctx, userID, messageID); cause != ErrInvalid {
			return Message{}, "", cause
		}
		return Message{}, "", ErrNotFound
	}
	return m, file.String, err
}

// Attachment returns a message's image if the user took part in the conversation.
func (s Store) Attachment(ctx context.Context, userID string, messageID int64) (Attachment, error) {
	m, err := scan(s.DB.QueryRowContext(ctx, `SELECT `+columns+` FROM direct_messages WHERE id=$1 AND (sender_id=$2 OR recipient_id=$2)`, messageID, userID))
	if err != nil {
		return Attachment{}, err
	}
	if m.Attachment == nil {
		return Attachment{}, sql.ErrNoRows
	}
	return *m.Attachment, nil
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
	rows, err := s.DB.QueryContext(ctx, `SELECT DISTINCT ON (mine.other) mine.id,mine.sender_id,mine.recipient_id,mine.body,mine.created_at,mine.read_at,
		mine.attachment_name,mine.attachment_type,mine.attachment_width,mine.attachment_height,mine.attachment_original_name,mine.attachment_size,
		mine.edited_at,mine.deleted_at,mine.other,
		(SELECT COUNT(*) FROM direct_messages u WHERE u.recipient_id=$1 AND u.sender_id=mine.other AND u.read_at IS NULL AND u.deleted_at IS NULL)
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
