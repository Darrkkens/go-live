package guilds

import (
	"context"
	"testing"
)

func testAccess(user string, owner bool, roles []string) Access {
	return Access{
		UserID: user, Owner: owner, roleIDs: roles, defaultRole: "everyone",
		roles: map[string]roleInfo{
			"everyone": {position: 0, permissions: DefaultPerms, isDefault: true},
			"mod":      {position: 2, permissions: PermKickMembers | PermManageMessages | PermMoveMembers | PermMuteMembers},
			"staff":    {position: 1, permissions: 0},
			"admin":    {position: 3, permissions: PermAdministrator},
		},
		overrides: map[string][]Override{
			// #equipe is private: @todos cannot see it, staff can.
			"equipe": {{RoleID: "everyone", Deny: PermViewChannel}, {RoleID: "staff", Allow: PermViewChannel}},
			// #avisos is read-only for @todos; mods may write.
			"avisos": {{RoleID: "everyone", Deny: PermSendMessages}, {RoleID: "mod", Allow: PermSendMessages}},
			// The "palco" voice channel: only mods speak.
			"palco": {{RoleID: "everyone", Deny: PermSpeak}, {RoleID: "mod", Allow: PermSpeak}},
		},
	}
}

func TestAccess(t *testing.T) {
	member := testAccess("m", false, nil)
	staff := testAccess("s", false, []string{"staff"})
	mod := testAccess("d", false, []string{"mod"})
	admin := testAccess("a", false, []string{"admin"})
	owner := testAccess("o", true, nil)

	if member.Has(PermKickMembers) || !mod.Has(PermKickMembers|PermManageMessages) {
		t.Fatal("role permissions are not added to @todos")
	}
	if !admin.Has(PermManageGuild) || admin.Guild() != PermAll || owner.Guild() != PermAll {
		t.Fatal("administrators and owners must have everything")
	}
	if member.Can("equipe", PermViewChannel) || member.Channel("equipe") != 0 {
		t.Fatal("private channel visible to @todos")
	}
	if !staff.Can("equipe", PermViewChannel|PermSendMessages) {
		t.Fatal("role allowed in private channel cannot see or write")
	}
	if !admin.Can("equipe", PermViewChannel) || !owner.Can("equipe", PermManageChannels) {
		t.Fatal("overrides must not limit administrators or the owner")
	}
	if member.Can("avisos", PermSendMessages) || !member.Can("avisos", PermViewChannel) || !mod.Can("avisos", PermSendMessages) {
		t.Fatal("read-only channel")
	}
	if member.Can("palco", PermSpeak) || !member.Can("palco", PermConnect) || !mod.Can("palco", PermSpeak) {
		t.Fatal("speak override")
	}
	if !member.Can("geral", PermSendMessages) {
		t.Fatal("a channel without overrides follows server permissions")
	}
	// Hierarchy: owner > admin(3) > mod(2) > staff(1) > @todos(0).
	if !mod.Outranks(staff) || staff.Outranks(mod) || mod.Outranks(admin) || admin.Outranks(owner) || !owner.Outranks(admin) {
		t.Fatal("hierarchy")
	}
	if member.Outranks(testAccess("x", false, nil)) {
		t.Fatal("equal rank must not outrank")
	}
}

func TestRolesAndOverridesInDatabase(t *testing.T) {
	ctx := context.Background()
	db, users, store, cleanup := testDB(t)
	defer cleanup()
	ana, bia, caio := users("ana"), users("bia"), users("caio")
	g, _ := store.Create(ctx, ana.ID, "Time")
	store.AddMember(ctx, g.ID, bia.ID)
	store.AddMember(ctx, g.ID, caio.ID)

	roles, _ := store.Roles(ctx, g.ID)
	if len(roles) != 1 || !roles[0].IsDefault || roles[0].Permissions != DefaultPerms || roles[0].Name != "@todos" {
		t.Fatalf("default role: %+v", roles)
	}
	mod, err := store.CreateRole(ctx, g.ID, "Moderador", "#E5484D", PermKickMembers|PermMoveMembers)
	if err != nil || mod.Position != 1 || mod.Color != "#e5484d" {
		t.Fatalf("create role: %+v %v", mod, err)
	}
	vip, _ := store.CreateRole(ctx, g.ID, "VIP", "", 0)
	if roles, _ := store.Roles(ctx, g.ID); roles[0].ID != mod.ID || roles[1].ID != vip.ID {
		t.Fatalf("new roles go right above @todos: %+v", roles)
	}
	if _, err := store.CreateRole(ctx, g.ID, "@todos", "", 0); err != ErrInvalid {
		t.Fatalf("@todos name accepted: %v", err)
	}
	if _, err := store.MoveRole(ctx, g.ID, vip.ID, true); err != nil {
		t.Fatal(err)
	}
	if roles, _ := store.Roles(ctx, g.ID); roles[0].ID != vip.ID {
		t.Fatalf("move up: %+v", roles)
	}
	if _, err := store.MoveRole(ctx, g.ID, roles[len(roles)-1].ID, true); err != ErrInvalid {
		t.Fatalf("@todos moved: %v", err)
	}
	if err := store.SetMemberRoles(ctx, g.ID, bia.ID, []string{mod.ID}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetMemberRoles(ctx, g.ID, bia.ID, []string{roles[len(roles)-1].ID}); err != ErrInvalid {
		t.Fatalf("@todos assigned explicitly: %v", err)
	}
	a, _ := store.Access(ctx, g.ID, bia.ID)
	if !a.Has(PermKickMembers) || a.Top() != 1 {
		t.Fatalf("bia access: %v top %d", a.Guild(), a.Top())
	}

	// A private channel for moderators.
	channels, _ := store.Channels(ctx, g.ID)
	priv, _ := store.CreateChannel(ctx, g.ID, "moderação", "", "text")
	everyone := roles[len(roles)-1].ID
	store.SetOverride(ctx, priv.ID, everyone, 0, PermViewChannel)
	store.SetOverride(ctx, priv.ID, mod.ID, PermViewChannel, 0)
	viewers, _ := store.ChannelViewers(ctx, g.ID, priv.ID)
	if len(viewers) != 2 || !contains(viewers, ana.ID) || !contains(viewers, bia.ID) {
		t.Fatalf("private channel viewers: %v", viewers)
	}
	if all, _ := store.ChannelViewers(ctx, g.ID, channels[0].ID); len(all) != 3 {
		t.Fatalf("public channel viewers: %v", all)
	}
	if o, _ := store.Overrides(ctx, g.ID); len(o[priv.ID]) != 2 || o[priv.ID][0].RoleID != mod.ID {
		t.Fatalf("overrides: %+v", o)
	}
	store.SetOverride(ctx, priv.ID, everyone, 0, 0)
	if o, _ := store.Overrides(ctx, g.ID); len(o[priv.ID]) != 1 {
		t.Fatalf("empty override kept: %+v", o)
	}

	// Voice user limit only applies to voice channels.
	voice, _ := store.CreateChannel(ctx, g.ID, "sala", "", "voice")
	if ch, err := store.UpdateChannel(ctx, voice.ID, "sala", "", 5); err != nil || ch.UserLimit != 5 {
		t.Fatalf("voice limit: %+v %v", ch, err)
	}
	if ch, _ := store.UpdateChannel(ctx, priv.ID, "moderação", "", 5); ch.UserLimit != 0 {
		t.Fatal("text channel got a user limit")
	}
	if _, err := store.UpdateChannel(ctx, voice.ID, "sala", "", 100); err != ErrInvalid {
		t.Fatalf("limit over 99: %v", err)
	}

	// Leaving drops the member's roles; deleting a role drops it from members.
	store.RemoveMember(ctx, g.ID, bia.ID)
	var n int
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM guild_member_roles WHERE user_id=$1`, bia.ID).Scan(&n)
	if n != 0 {
		t.Fatal("roles kept after leaving")
	}
	store.SetMemberRoles(ctx, g.ID, caio.ID, []string{vip.ID})
	if err := store.DeleteRole(ctx, g.ID, vip.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteRole(ctx, g.ID, everyone); err != ErrInvalid {
		t.Fatalf("@todos deleted: %v", err)
	}
	if a, _ := store.Access(ctx, g.ID, caio.ID); len(a.RoleIDs()) != 0 {
		t.Fatal("deleted role still assigned")
	}
	if roles, _ := store.Roles(ctx, g.ID); roles[0].Position != 1 {
		t.Fatalf("positions not compacted: %+v", roles)
	}
}

func TestLegacyAdminsBecomeAdminRole(t *testing.T) {
	ctx := context.Background()
	db, users, store, cleanup := testDB(t)
	defer cleanup()
	ana, bia := users("ana"), users("bia")
	g, _ := store.Create(ctx, ana.ID, "Antigo")
	store.AddMember(ctx, g.ID, bia.ID)
	// Simulate a server from before roles: no roles, bia is a legacy admin.
	db.ExecContext(ctx, `DELETE FROM guild_roles WHERE guild_id=$1`, g.ID)
	db.ExecContext(ctx, `UPDATE guild_members SET role='admin' WHERE user_id=$1`, bia.ID)
	if err := store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	a, err := store.Access(ctx, g.ID, bia.ID)
	if err != nil || !a.Has(PermAdministrator) {
		t.Fatalf("legacy admin lost powers: %v %v", a.Guild(), err)
	}
	if roles, _ := store.Roles(ctx, g.ID); len(roles) != 2 || roles[0].Name != "Admin" || !roles[1].IsDefault {
		t.Fatalf("roles after migration: %+v", roles)
	}
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
