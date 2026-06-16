// Package dbtest centralises test-database setup so every Go test package gets
// the same isolation guarantees against the one shared Postgres test database.
//
// Two things this package fixes, which the inline per-package setup did not:
//
//  1. Cross-package races. `go test ./...` runs packages in parallel, and every
//     DB-touching test TRUNCATEs the shared database to a clean slate. Without
//     coordination, one package's TRUNCATE can wipe rows out from under another
//     package's in-flight assertions — an observed nondeterministic failure of
//     TestEmptyListsReturnArraysNotNull. Open holds a Postgres session advisory
//     lock for the lifetime of each test, so DB-touching tests serialise across
//     packages and processes without needing `go test -p 1`.
//
//  2. A drifting truncate list. The list of tables to wipe previously lived in
//     two copies (httpapi truncated link_previews; cmd/server didn't). It now
//     has a single source of truth here.
package dbtest

import (
	"context"
	"os"
	"sync"
	"testing"

	"rivendell/internal/store"
)

// advisoryLockKey is an arbitrary fixed key ("rivendel" in ASCII) on which all
// DB-touching tests serialise via pg_advisory_lock.
const advisoryLockKey int64 = 0x726976656e64656c

// canonicalTruncate is the single source of truth for the clean-slate wipe. Any
// new table that carries per-test state must be added here.
const canonicalTruncate = `TRUNCATE link_previews, push_subscriptions, blobs, emojis, ` +
	`channel_mutes, message_mentions, channel_reads, messages, channel_members, ` +
	`channels, magic_links, invitations, bot_tokens, sessions, users ` +
	`RESTART IDENTITY CASCADE`

// migrateOnce ensures the schema is built at most once per test process; see Open.
var (
	migrateOnce sync.Once
	migrateErr  error
)

// DSN returns the test database connection string from TEST_DATABASE_URL, or a
// localhost default for ad-hoc runs.
func DSN() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://chat:chat_dev_pw@localhost:5432/chat_test?sslmode=disable"
}

// Open opens and migrates the shared test database, serialises against other
// test packages via a session advisory lock, truncates to a clean slate, and
// registers cleanup (lock release + close) with t. It skips the calling test
// when no database is reachable.
func Open(t *testing.T) *store.Store {
	t.Helper()
	ctx := context.Background()

	st, err := store.Open(ctx, DSN())
	if err != nil {
		t.Skipf("no test database (%v); set TEST_DATABASE_URL to run", err)
	}

	// Hold the advisory lock on its own dedicated connection for the whole
	// test, so the release is guaranteed to target the same backend that took
	// it. Closing the connection releases the lock too, so the unlock below is
	// belt-and-braces. Acquire before Migrate so even migrations serialise.
	lockConn, err := st.DB().Conn(ctx)
	if err != nil {
		st.Close()
		t.Fatalf("acquire lock conn: %v", err)
	}
	if _, err := lockConn.ExecContext(ctx, "SELECT pg_advisory_lock($1)", advisoryLockKey); err != nil {
		lockConn.Close()
		st.Close()
		t.Fatalf("advisory lock: %v", err)
	}
	cleanup := func() {
		_, _ = lockConn.ExecContext(ctx, "SELECT pg_advisory_unlock($1)", advisoryLockKey)
		_ = lockConn.Close()
		st.Close()
	}

	// Migrations only need to run once per process: the schema persists in the
	// shared DB across tests (only the data is TRUNCATEd each time), so re-running
	// Migrate per test just repeats 20+ "already applied?" round-trips for nothing.
	// The first Open does it under the advisory lock, so a concurrent process
	// can't race the initial migration.
	migrateOnce.Do(func() { migrateErr = st.Migrate(ctx) })
	if migrateErr != nil {
		cleanup()
		t.Fatalf("migrate: %v", migrateErr)
	}
	if _, err := st.DB().Exec(canonicalTruncate); err != nil {
		cleanup()
		t.Fatalf("truncate: %v", err)
	}

	t.Cleanup(cleanup)
	return st
}
