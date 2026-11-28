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
	err := s.DB.QueryRowContext(ctx, `SELECT `+changeWindowSQL+` FROM direct_messages WHERE id=$1 AND sender_id=$2 AND deleted_at IS NULL AND call_status IS NULL`, messageID, userID).Scan(&inWindow)
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
	RecipientID string      `json:"recipientId,omitempty"`
	ChannelID   string      `json:"channelId,omitempty"`
	Body        string      `json:"body"`
	Attachment  *Attachment `json:"attachment"`
	CreatedAt   time.Time   `json:"createdAt"`
	ReadAt      *time.Time  `json:"readAt"`
	EditedAt    *time.Time  `json:"editedAt"`
	DeletedAt   *time.Time  `json:"deletedAt"`
	Call        *CallRecord `json:"call"`
}

// CallRecord is the history entry of a call, shown in the conversation.
type CallRecord struct {
	ID       string `json:"id"`
	Status   string `json:"status"`
	Media    string `json:"media"`
	Duration int    `json:"duration"`
}

// Call statuses. Ringing and active are live; the rest are final.
const (
	CallRinging   = "ringing"
	CallActive    = "active"
	CallEnded     = "ended"
	CallMissed    = "missed"
	CallDeclined  = "declined"
	CallCancelled = "cancelled"
)

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
		ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
		ADD COLUMN IF NOT EXISTS call_id TEXT,
		ADD COLUMN IF NOT EXISTS call_status TEXT,
		ADD COLUMN IF NOT EXISTS call_media TEXT,
		ADD COLUMN IF NOT EXISTS call_duration INT,
		ADD COLUMN IF NOT EXISTS channel_id UUID;
	-- A message goes either to one user (direct message) or to a server channel.
	ALTER TABLE direct_messages ALTER COLUMN recipient_id DROP NOT NULL;
	DO $$ BEGIN
		IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='direct_messages_target_check') THEN
			ALTER TABLE direct_messages ADD CONSTRAINT direct_messages_target_check CHECK ((recipient_id IS NULL) <> (channel_id IS NULL));
		END IF;
	END $$;
	CREATE INDEX IF NOT EXISTS direct_messages_channel_idx ON direct_messages (channel_id, id DESC) WHERE channel_id IS NOT NULL;
	CREATE TABLE IF NOT EXISTS channel_reads (
		user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		channel_id UUID NOT NULL,
		last_read_id BIGINT NOT NULL DEFAULT 0,
		PRIMARY KEY (user_id, channel_id)
	);
	DO $$ BEGIN
		IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='direct_messages_content_v3_check') THEN
			ALTER TABLE direct_messages DROP CONSTRAINT IF EXISTS direct_messages_body_check;
			ALTER TABLE direct_messages DROP CONSTRAINT IF EXISTS direct_messages_content_check;
			ALTER TABLE direct_messages DROP CONSTRAINT IF EXISTS direct_messages_content_v2_check;
			ALTER TABLE direct_messages ADD CONSTRAINT direct_messages_content_v3_check CHECK (
				char_length(body) <= 4000 AND (deleted_at IS NOT NULL OR char_length(body) > 0 OR attachment_name IS NOT NULL OR call_status IS NOT NULL));
		END IF;
	END $$;
	CREATE UNIQUE INDEX IF NOT EXISTS direct_messages_call_idx ON direct_messages (call_id) WHERE call_id IS NOT NULL;
	-- Calls live in server memory; after a restart unfinished ones are closed.
	UPDATE direct_messages SET call_status = CASE call_status WHEN 'ringing' THEN 'missed' ELSE 'ended' END
		WHERE call_status IN ('ringing','active');`)
	return err
}

const columns = `id,sender_id,recipient_id,body,created_at,read_at,attachment_name,attachment_type,attachment_width,attachment_height,attachment_original_name,attachment_size,edited_at,deleted_at,call_id,call_status,call_media,call_duration,channel_id`

func scanInto(row interface{ Scan(...any) error }, m *Message, extra ...any) error {
	var readAt, editedAt, deletedAt sql.NullTime
	var recipient, channel, name, contentType, original, callID, callStatus, callMedia sql.NullString
	var width, height, size, callDuration sql.NullInt64
	dest := append([]any{&m.ID, &m.SenderID, &recipient, &m.Body, &m.CreatedAt, &readAt, &name, &contentType, &width, &height, &original, &size, &editedAt, &deletedAt, &callID, &callStatus, &callMedia, &callDuration, &channel}, extra...)
	if err := row.Scan(dest...); err != nil {
		return err
	}
	m.RecipientID, m.ChannelID = recipient.String, channel.String
	for _, t := range []struct {
		src sql.NullTime
		dst **time.Time
	}{{readAt, &m.ReadAt}, {editedAt, &m.EditedAt}, {deletedAt, &m.DeletedAt}} {
		if t.src.Valid {
			v := t.src.Time
			*t.dst = &v
		}
	}
	if callStatus.Valid {
		m.Call = &CallRecord{ID: callID.String, Status: callStatus.String, Media: callMedia.String, Duration: int(callDuration.Int64)}
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
		WHERE id=$1 AND sender_id=$2 AND deleted_at IS NULL AND call_status IS NULL AND ($3<>'' OR attachment_name IS NOT NULL) AND `+changeWindowSQL+`
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
			SELECT id, attachment_name FROM direct_messages WHERE id=$1 AND sender_id=$2 AND deleted_at IS NULL AND call_status IS NULL AND `+changeWindowSQL+` FOR UPDATE
		)
		UPDATE direct_messages m SET body='', deleted_at=NOW(), edited_at=NULL, attachment_name=NULL, attachment_type=NULL,
			attachment_width=NULL, attachment_height=NULL, attachment_original_name=NULL, attachment_size=NULL
		FROM old WHERE m.id=old.id
		RETURNING m.id,m.sender_id,m.recipient_id,m.body,m.created_at,m.read_at,m.attachment_name,m.attachment_type,m.attachment_width,
			m.attachment_height,m.attachment_original_name,m.attachment_size,m.edited_at,m.deleted_at,m.call_id,m.call_status,m.call_media,m.call_duration,m.channel_id,old.attachment_name`, messageID, userID), &m, &file)
	if errors.Is(err, sql.ErrNoRows) {
		if cause := s.changeError(ctx, userID, messageID); cause != ErrInvalid {
			return Message{}, "", cause
		}
		return Message{}, "", ErrNotFound
	}
	return m, file.String, err
}

// DeleteAny removes any channel message (moderation), with no time limit.
func (s Store) DeleteAny(ctx context.Context, messageID int64) (Message, string, error) {
	var m Message
	var file sql.NullString
	err := scanInto(s.DB.QueryRowContext(ctx, `WITH old AS (
			SELECT id, attachment_name FROM direct_messages WHERE id=$1 AND channel_id IS NOT NULL AND deleted_at IS NULL FOR UPDATE
		)
		UPDATE direct_messages m SET body='', deleted_at=NOW(), edited_at=NULL, attachment_name=NULL, attachment_type=NULL,
			attachment_width=NULL, attachment_height=NULL, attachment_original_name=NULL, attachment_size=NULL
		FROM old WHERE m.id=old.id
		RETURNING m.id,m.sender_id,m.recipient_id,m.body,m.created_at,m.read_at,m.attachment_name,m.attachment_type,m.attachment_width,
			m.attachment_height,m.attachment_original_name,m.attachment_size,m.edited_at,m.deleted_at,m.call_id,m.call_status,m.call_media,m.call_duration,m.channel_id,old.attachment_name`, messageID), &m, &file)
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, "", ErrNotFound
	}
	return m, file.String, err
}

// StartCall records a call from caller to an active callee with the given status.
func (s Store) StartCall(ctx context.Context, callerID, calleeID, callID, media, status string) (Message, error) {
	if callerID == calleeID {
		return Message{}, ErrRecipient
	}
	if (media != "audio" && media != "video") || (status != CallRinging && status != CallMissed) {
		return Message{}, ErrInvalid
	}
	m, err := scan(s.DB.QueryRowContext(ctx, `INSERT INTO direct_messages (sender_id,recipient_id,body,call_id,call_status,call_media,call_duration)
		SELECT $1,id,'',$3,$4,$5,0 FROM users WHERE id=$2 AND account_status='active'
		RETURNING `+columns, callerID, calleeID, callID, status, media))
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, ErrRecipient
	}
	return m, err
}

// UpdateCall changes the status (and duration in seconds) of a recorded call.
func (s Store) UpdateCall(ctx context.Context, callID, status string, duration int) (Message, error) {
	m, err := scan(s.DB.QueryRowContext(ctx, `UPDATE direct_messages SET call_status=$2, call_duration=$3 WHERE call_id=$1 RETURNING `+columns, callID, status, duration))
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, ErrNotFound
	}
	return m, err
}

// Get returns one message by id; callers check who may see it.
func (s Store) Get(ctx context.Context, messageID int64) (Message, error) {
	m, err := scan(s.DB.QueryRowContext(ctx, `SELECT `+columns+` FROM direct_messages WHERE id=$1`, messageID))
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, ErrNotFound
	}
	return m, err
}

// Attachment returns a direct message's attachment if the user took part in the conversation.
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
		mine.edited_at,mine.deleted_at,mine.call_id,mine.call_status,mine.call_media,mine.call_duration,mine.channel_id,mine.other,
		(SELECT COUNT(*) FROM direct_messages u WHERE u.recipient_id=$1 AND u.sender_id=mine.other AND u.read_at IS NULL AND u.deleted_at IS NULL
			AND (u.call_status IS NULL OR u.call_status IN ('missed','cancelled')))
		FROM (SELECT m.*, CASE WHEN m.sender_id=$1 THEN m.recipient_id ELSE m.sender_id END AS other
			FROM direct_messages m WHERE (m.sender_id=$1 OR m.recipient_id=$1) AND m.channel_id IS NULL) mine
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

// SendToChannel stores a message in a server channel. The caller checks membership.
func (s Store) SendToChannel(ctx context.Context, senderID, channelID, body string, a *Attachment) (Message, error) {
	var err error
	if a == nil || strings.TrimSpace(body) != "" {
		if body, err = NormalizeBody(body); err != nil {
			return Message{}, err
		}
	} else {
		body = ""
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
	m, err := scan(s.DB.QueryRowContext(ctx, `INSERT INTO direct_messages (sender_id,channel_id,body,attachment_name,attachment_type,attachment_width,attachment_height,attachment_original_name,attachment_size)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING `+columns, senderID, channelID, body, name, contentType, width, height, original, size))
	if err != nil {
		return Message{}, err
	}
	// The sender has read everything up to their own message.
	_, err = s.DB.ExecContext(ctx, `INSERT INTO channel_reads (user_id,channel_id,last_read_id) VALUES ($1,$2,$3)
		ON CONFLICT (user_id,channel_id) DO UPDATE SET last_read_id=GREATEST(channel_reads.last_read_id, EXCLUDED.last_read_id)`, senderID, channelID, m.ID)
	return m, err
}

// ChannelHistory returns up to limit channel messages, oldest first, with ids lower than before.
func (s Store) ChannelHistory(ctx context.Context, channelID string, before int64, limit int) ([]Message, error) {
	if limit <= 0 || limit > MaxPageSize {
		limit = DefaultPageSize
	}
	if before <= 0 {
		before = 1<<63 - 1
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT `+columns+` FROM direct_messages WHERE channel_id=$1 AND id<$2 ORDER BY id DESC LIMIT $3`, channelID, before, limit)
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

// MarkChannelRead records that the user has read the channel up to its latest message.
func (s Store) MarkChannelRead(ctx context.Context, userID, channelID string) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO channel_reads (user_id,channel_id,last_read_id)
		SELECT $1,$2,COALESCE(MAX(id),0) FROM direct_messages WHERE channel_id=$2
		ON CONFLICT (user_id,channel_id) DO UPDATE SET last_read_id=GREATEST(channel_reads.last_read_id, EXCLUDED.last_read_id)`, userID, channelID)
	return err
}

// ChannelUnread counts messages from others the user has not read, per channel.
func (s Store) ChannelUnread(ctx context.Context, userID string, channelIDs []string) (map[string]int, error) {
	counts := map[string]int{}
	if len(channelIDs) == 0 {
		return counts, nil
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT m.channel_id, COUNT(*) FROM direct_messages m
		LEFT JOIN channel_reads r ON r.user_id=$1 AND r.channel_id=m.channel_id
		WHERE m.channel_id = ANY($2::uuid[]) AND m.sender_id<>$1 AND m.deleted_at IS NULL AND m.id > COALESCE(r.last_read_id,0)
		GROUP BY m.channel_id`, userID, "{"+strings.Join(channelIDs, ",")+"}")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		counts[id] = n
	}
	return counts, rows.Err()
}
