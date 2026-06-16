package httpapi

import (
	"context"
	"testing"

	"rivendell/internal/store"
)

// TestChannelVisibleTo pins the single visibility predicate that every audience/
// access decision delegates to (realtime.go). The privacy-critical lines are the
// DM cases: a DM is strictly members-only, so an admin who is NOT a participant
// must NOT see it — unlike a private non-DM channel, where admins have an
// override. Bypasses the HTTP layer and exercises the predicate directly.
func TestChannelVisibleTo(t *testing.T) {
	_, st, _, srv := newTestServerSrv(t)
	ctx := context.Background()

	admin, err := st.CreateUser(ctx, "admin1", "Admin", store.RoleAdmin)
	if err != nil {
		t.Fatalf("create admin: %v", err)
	}
	member, err := st.CreateUser(ctx, "member1", "Member", store.RoleMember)
	if err != nil {
		t.Fatalf("create member: %v", err)
	}
	other, err := st.CreateUser(ctx, "other1", "Other", store.RoleMember)
	if err != nil {
		t.Fatalf("create other: %v", err)
	}

	// Public channel — visible to everyone, member or not.
	pub, err := st.CreateChannel(ctx, "general", "", false, member.ID)
	if err != nil {
		t.Fatalf("create public channel: %v", err)
	}

	// Private non-DM channel — `member` is a member; admins get an override.
	// store.CreateChannel does NOT add the creator as a member (the HTTP handler
	// does that one layer up), so add membership explicitly.
	priv, err := st.CreateChannel(ctx, "secret-room", "", true, member.ID)
	if err != nil {
		t.Fatalf("create private channel: %v", err)
	}
	if err := st.AddChannelMember(ctx, priv.ID, member.ID); err != nil {
		t.Fatalf("add member to private channel: %v", err)
	}

	// DM between member and other — GetOrCreateDM seeds both as members.
	dm, _, err := st.GetOrCreateDM(ctx, member.ID, other.ID)
	if err != nil {
		t.Fatalf("create DM: %v", err)
	}

	cases := []struct {
		name string
		ch   store.Channel
		u    store.User
		want bool
	}{
		{"public visible to non-member member-role", pub, other, true},
		{"public visible to admin", pub, admin, true},

		{"private visible to its member", priv, member, true},
		{"private visible to admin (override)", priv, admin, true},
		{"private hidden from non-member non-admin", priv, other, false},

		{"dm visible to participant", dm, member, true},
		{"dm visible to other participant", dm, other, true},
		{"dm hidden from admin (strictly members-only)", dm, admin, false},
	}
	for _, tc := range cases {
		if got := srv.channelVisibleTo(ctx, tc.ch, tc.u); got != tc.want {
			t.Errorf("%s: channelVisibleTo = %v, want %v", tc.name, got, tc.want)
		}
	}
}
