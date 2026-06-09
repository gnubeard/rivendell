package main

import (
	"context"
	"os"
	"testing"
	"time"

	"rivendell/internal/config"
	"rivendell/internal/store"
)

func testDSN() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://chat:chat_dev_pw@localhost:5432/chat_test?sslmode=disable"
}

// openTestStore opens + migrates the test database and truncates it to a clean
// slate, skipping the whole test when no database is reachable.
func openTestStore(t *testing.T) *store.Store {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(ctx, testDSN())
	if err != nil {
		t.Skipf("no test database (%v); set TEST_DATABASE_URL to run", err)
	}
	if err := st.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	_, err = st.DB().Exec(`TRUNCATE push_subscriptions, blobs, emojis, channel_mutes, message_mentions, channel_reads, messages, channel_members, channels, magic_links, invitations, bot_tokens, sessions, users RESTART IDENTITY CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

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
	st := openTestStore(t)

	maybeBootstrap(ctx, bootstrapCfg(), st)

	if n, err := st.CountAdmins(ctx); err != nil {
		t.Fatalf("count admins: %v", err)
	} else if n != 1 {
		t.Fatalf("want 1 admin after bootstrap, got %d", n)
	}

	channels, err := st.ListChannels(ctx)
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
	st := openTestStore(t)

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
	st := openTestStore(t)

	// Seed a user + a pre-existing channel, but no admin.
	u, err := st.CreateUser(ctx, "member1", "Member One", store.RoleMember)
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	if _, err := st.CreateChannel(ctx, "lobby", "", false, u.ID); err != nil {
		t.Fatalf("create channel: %v", err)
	}

	maybeBootstrap(ctx, bootstrapCfg(), st)

	channels, err := st.ListChannels(ctx)
	if err != nil {
		t.Fatalf("list channels: %v", err)
	}
	if len(channels) != 1 || channels[0].Name != "lobby" {
		t.Fatalf("bootstrap should not have added #general; channels=%v", channels)
	}
}
