package guilds

import (
	"context"
	"database/sql"
	"errors"
	"math"
)

// Permission bits, as in Discord. Stored as BIGINT on roles and channel overrides.
const (
	PermAdministrator uint64 = 1 << iota
	PermManageGuild
	PermManageChannels
	PermManageRoles
	PermCreateInvite
	PermAddMembers
	PermKickMembers
	PermManageMessages
	PermViewChannel
	PermSendMessages
	PermAttachFiles
	PermConnect
	PermSpeak
	PermVideo
	PermMoveMembers
	PermMuteMembers
)

// PermAll is every permission; owners and administrators have it.
const PermAll = PermAdministrator<<16 - 1

// ChannelPerms are the permissions that channel overrides can change.
const ChannelPerms = PermManageChannels | PermViewChannel | PermSendMessages | PermAttachFiles | PermManageMessages |
	PermConnect | PermSpeak | PermVideo | PermMoveMembers | PermMuteMembers | PermCreateInvite

// DefaultPerms is what @todos gets in a new server: read, write and talk.
const DefaultPerms = PermViewChannel | PermSendMessages | PermAttachFiles | PermConnect | PermSpeak | PermVideo

// Override changes a role's permissions in one channel.
type Override struct {
	RoleID string `json:"roleId"`
	Allow  uint64 `json:"allow"`
	Deny   uint64 `json:"deny"`
}

type roleInfo struct {
	position    int
	permissions uint64
	isDefault   bool
}

// Access is one member's effective permissions in a server.
type Access struct {
	UserID      string
	Owner       bool
	roleIDs     []string
	roles       map[string]roleInfo
	defaultRole string
	overrides   map[string][]Override
}

// Guild returns the server-wide permissions.
func (a Access) Guild() uint64 {
	if a.Owner {
		return PermAll
	}
	perms := a.roles[a.defaultRole].permissions
	for _, id := range a.roleIDs {
		perms |= a.roles[id].permissions
	}
	if perms&PermAdministrator != 0 {
		return PermAll
	}
	return perms
}

// Has reports a server-wide permission.
func (a Access) Has(p uint64) bool { return a.Guild()&p == p }

// Channel returns the permissions in a channel after its overrides.
func (a Access) Channel(channelID string) uint64 {
	perms := a.Guild()
	if perms == PermAll {
		return PermAll
	}
	list := a.overrides[channelID]
	for _, o := range list {
		if o.RoleID == a.defaultRole {
			perms = perms&^o.Deny | o.Allow
		}
	}
	var allow, deny uint64
	mine := map[string]bool{}
	for _, id := range a.roleIDs {
		mine[id] = true
	}
	for _, o := range list {
		if mine[o.RoleID] {
			allow |= o.Allow
			deny |= o.Deny
		}
	}
	perms = perms&^deny | allow
	if perms&PermViewChannel == 0 {
		return 0
	}
	return perms
}

// Can reports a permission in a channel.
func (a Access) Can(channelID string, p uint64) bool { return a.Channel(channelID)&p == p }

// Top is the position of the member's highest role; the owner is above everyone.
func (a Access) Top() int {
	if a.Owner {
		return math.MaxInt
	}
	top := 0
	for _, id := range a.roleIDs {
		if p := a.roles[id].position; p > top {
			top = p
		}
	}
	return top
}

// Outranks reports whether the member may act on other (kick, mute, edit roles).
func (a Access) Outranks(other Access) bool {
	return !other.Owner && (a.Owner || a.Top() > other.Top())
}

// RoleIDs lists the member's roles (without @todos).
func (a Access) RoleIDs() []string { return append([]string(nil), a.roleIDs...) }

// guildPerms holds what is needed to compute everyone's access in one server.
type guildPerms struct {
	ownerID     string
	roles       map[string]roleInfo
	defaultRole string
	overrides   map[string][]Override
	memberRoles map[string][]string
}

func (s Store) loadPerms(ctx context.Context, guildID string, onlyUser string) (guildPerms, error) {
	gp := guildPerms{roles: map[string]roleInfo{}, overrides: map[string][]Override{}, memberRoles: map[string][]string{}}
	if err := s.DB.QueryRowContext(ctx, `SELECT owner_id FROM guilds WHERE id=$1`, guildID).Scan(&gp.ownerID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return gp, ErrNotFound
		}
		return gp, err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT id,position,permissions,is_default FROM guild_roles WHERE guild_id=$1`, guildID)
	if err != nil {
		return gp, err
	}
	for rows.Next() {
		var id string
		var r roleInfo
		var perms int64
		if err := rows.Scan(&id, &r.position, &perms, &r.isDefault); err != nil {
			rows.Close()
			return gp, err
		}
		r.permissions = uint64(perms)
		gp.roles[id] = r
		if r.isDefault {
			gp.defaultRole = id
		}
	}
	rows.Close()
	rows, err = s.DB.QueryContext(ctx, `SELECT o.channel_id,o.role_id,o.allow,o.deny FROM channel_overrides o JOIN channels c ON c.id=o.channel_id WHERE c.guild_id=$1`, guildID)
	if err != nil {
		return gp, err
	}
	for rows.Next() {
		var ch string
		var o Override
		var allow, deny int64
		if err := rows.Scan(&ch, &o.RoleID, &allow, &deny); err != nil {
			rows.Close()
			return gp, err
		}
		o.Allow, o.Deny = uint64(allow), uint64(deny)
		gp.overrides[ch] = append(gp.overrides[ch], o)
	}
	rows.Close()
	query := `SELECT m.user_id, r.role_id FROM guild_members m LEFT JOIN guild_member_roles r ON r.guild_id=m.guild_id AND r.user_id=m.user_id WHERE m.guild_id=$1`
	args := []any{guildID}
	if onlyUser != "" {
		query += ` AND m.user_id=$2`
		args = append(args, onlyUser)
	}
	rows, err = s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return gp, err
	}
	defer rows.Close()
	for rows.Next() {
		var user string
		var role sql.NullString
		if err := rows.Scan(&user, &role); err != nil {
			return gp, err
		}
		if _, ok := gp.memberRoles[user]; !ok {
			gp.memberRoles[user] = []string{}
		}
		if role.Valid {
			gp.memberRoles[user] = append(gp.memberRoles[user], role.String)
		}
	}
	return gp, rows.Err()
}

func (gp guildPerms) access(userID string) (Access, bool) {
	roles, ok := gp.memberRoles[userID]
	if !ok {
		return Access{}, false
	}
	return Access{UserID: userID, Owner: userID == gp.ownerID, roleIDs: roles, roles: gp.roles, defaultRole: gp.defaultRole, overrides: gp.overrides}, true
}

// Access loads one member's permissions; ErrNotFound if they are not a member.
func (s Store) Access(ctx context.Context, guildID, userID string) (Access, error) {
	gp, err := s.loadPerms(ctx, guildID, userID)
	if err != nil {
		return Access{}, err
	}
	a, ok := gp.access(userID)
	if !ok {
		return Access{}, ErrNotFound
	}
	return a, nil
}

// AccessAll loads every member's permissions, e.g. to decide who sees a channel.
func (s Store) AccessAll(ctx context.Context, guildID string) (map[string]Access, error) {
	gp, err := s.loadPerms(ctx, guildID, "")
	if err != nil {
		return nil, err
	}
	out := make(map[string]Access, len(gp.memberRoles))
	for user := range gp.memberRoles {
		a, _ := gp.access(user)
		out[user] = a
	}
	return out, nil
}

// ChannelViewers lists the members who can see a channel.
func (s Store) ChannelViewers(ctx context.Context, guildID, channelID string) ([]string, error) {
	all, err := s.AccessAll(ctx, guildID)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for id, a := range all {
		if a.Can(channelID, PermViewChannel) {
			ids = append(ids, id)
		}
	}
	return ids, nil
}
