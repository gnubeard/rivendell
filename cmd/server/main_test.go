package main

import (
	"context"
	"testing"
	"time"

	"rivendell/internal/config"
	"rivendell/internal/dbtest"
	"rivendell/internal/store"
)

func bootstrapCfg() config.Config {
	return config.Config{
		MagicLinkTTL:   time.Hour,
		PublicURL:      "http://rivendell.test",
		BootstrapAdmin: "admin",
	}
}

// TestBootstrapSeedsAdminAndGeneralChannel: a fresh instance gets a first admin
// AND a default public #general channel, so the sidebar isn't blank on arrival.
func TestBootstrapSeedsAdminAndGeneralChannel(t *testing.T) {
	ctx := context.Background()
	st := dbtest.Open(t)

	maybeBootstrap(ctx, bootstrapCfg(), st)

	if n, err := st.CountAdmins(ctx); err != nil {
		t.Fatalf("count admins: %v", err)
	} else if n != 1 {
		t.Fatalf("want 1 admin after bootstrap, got %d", n)
	}

	channels, err := st.ListChannels(ctx, 0)
	if err != nil {
		t.Fatalf("list channels: %v", err)
	}
	if len(channels) != 1 {
		t.Fatalf("want 1 channel after bootstrap, got %d", len(channels))
	}
	ch := channels[0]
	if ch.Name != "general" {
		t.Errorf("want default channel name %q, got %q", "general", ch.Name)
	}
	if ch.IsPrivate {
		t.Error("default #general channel should be public, not private")
	}
}

// TestBootstrapIsIdempotent: a second bootstrap on an already-seeded instance is
// a no-op — no duplicate admin, no duplicate (or resurrected) #general.
func TestBootstrapIsIdempotent(t *testing.T) {
	ctx := context.Background()
	st := dbtest.Open(t)

	maybeBootstrap(ctx, bootstrapCfg(), st)
	maybeBootstrap(ctx, bootstrapCfg(), st)

	if n, err := st.CountAdmins(ctx); err != nil {
		t.Fatalf("count admins: %v", err)
	} else if n != 1 {
		t.Fatalf("want 1 admin after double bootstrap, got %d", n)
	}
	if n, err := st.CountChannels(ctx); err != nil {
		t.Fatalf("count channels: %v", err)
	} else if n != 1 {
		t.Fatalf("want 1 channel after double bootstrap, got %d", n)
	}
}

// TestBootstrapSkipsGeneralWhenChannelsExist: if an instance somehow has zero
// admins but pre-existing channels, bootstrap creates the admin but does NOT
// add #general over the operator's existing room layout.
func TestBootstrapSkipsGeneralWhenChannelsExist(t *testing.T) {
	ctx := context.Background()
	st := dbtest.Open(t)

	// Seed a user + a pre-existing channel, but no admin.
	u, err := st.CreateUser(ctx, "member1", "Member One", store.RoleMember)
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	if _, err := st.CreateChannel(ctx, "lobby", "", false, u.ID); err != nil {
		t.Fatalf("create channel: %v", err)
	}

	maybeBootstrap(ctx, bootstrapCfg(), st)

	channels, err := st.ListChannels(ctx, 0)
	if err != nil {
		t.Fatalf("list channels: %v", err)
	}
	if len(channels) != 1 || channels[0].Name != "lobby" {
		t.Fatalf("bootstrap should not have added #general; channels=%v", channels)
	}
}
