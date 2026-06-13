// Command server is the rivendell chat server entrypoint. It loads configuration
// from the environment, runs database migrations, and serves the HTTP API plus
// the static web client.
//
// Bootstrap the first admin with:
//
//	rivendell -create-admin alice "Alice Example"
//
// which prints a one-time magic link the admin opens to set their password.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"rivendell/internal/auth"
	"rivendell/internal/config"
	"rivendell/internal/httpapi"
	"rivendell/internal/store"
)

func main() {
	var (
		createAdmin = flag.Bool("create-admin", false, "create an admin user and print a set-password link, then exit")
		migrateOnly = flag.Bool("migrate", false, "run database migrations and exit")
	)
	flag.Parse()

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	ctx := context.Background()

	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer st.Close()

	if err := st.Migrate(ctx); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	if *migrateOnly {
		log.Println("migrations applied")
		return
	}

	if *createAdmin {
		runCreateAdmin(ctx, cfg, st, flag.Args())
		return
	}

	srv := httpapi.New(cfg, st)

	// On an empty install, create the first admin and log a setup link so the
	// operator can get in without running a separate command (handy in a
	// container, where there's no host Go toolchain to `go run` the bootstrap).
	maybeBootstrap(ctx, cfg, st)

	// Background session sweeper.
	go func() {
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for range t.C {
			if n, err := st.DeleteExpiredSessions(context.Background()); err != nil {
				log.Printf("session sweep: %v", err)
			} else if n > 0 {
				log.Printf("session sweep: removed %d expired", n)
			}
		}
	}()

	// Background link-preview cache sweeper.
	go func() {
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for range t.C {
			if n, err := st.DeleteExpiredLinkPreviews(context.Background()); err != nil {
				log.Printf("link preview sweep: %v", err)
			} else if n > 0 {
				log.Printf("link preview sweep: removed %d expired", n)
			}
		}
	}()

	hs := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: long-lived websocket connections live on this server.
	}
	log.Printf("rivendell listening on %s (web dir %s)", cfg.Addr, cfg.WebDir)
	if err := hs.ListenAndServe(); err != nil {
		log.Fatalf("server: %v", err)
	}
}

func runCreateAdmin(ctx context.Context, cfg config.Config, st *store.Store, args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: rivendell -create-admin <username> [display name]")
		os.Exit(2)
	}
	username := args[0]
	displayName := username
	if len(args) > 1 {
		displayName = args[1]
	}

	u, err := st.CreateUser(ctx, username, displayName, store.RoleAdmin)
	if err != nil {
		if store.IsUniqueViolation(err) {
			log.Fatalf("user %q already exists", username)
		}
		log.Fatalf("create admin: %v", err)
	}

	url, expires, err := mintSetPasswordLink(ctx, cfg, st, u.ID)
	if err != nil {
		log.Fatalf("create magic link: %v", err)
	}

	fmt.Println()
	fmt.Printf("Created admin %q (id %d).\n", username, u.ID)
	fmt.Println("Open this one-time link to set the password:")
	fmt.Println()
	fmt.Printf("  %s\n", url)
	fmt.Println()
	fmt.Printf("Link expires %s.\n", expires.Format(time.RFC1123))
}

// maybeBootstrap creates the first admin on an empty install and logs a
// set-password link. It only fires when there are zero admins, so it's a no-op
// on every subsequent start. If the chosen username is somehow already taken,
// it logs and moves on rather than failing startup.
func maybeBootstrap(ctx context.Context, cfg config.Config, st *store.Store) {
	n, err := st.CountAdmins(ctx)
	if err != nil {
		log.Printf("bootstrap: admin count check failed: %v", err)
		return
	}
	if n > 0 {
		return
	}

	username := cfg.BootstrapAdmin
	if username == "" {
		username = "admin"
	}
	u, err := st.CreateUser(ctx, username, username, store.RoleAdmin)
	if err != nil {
		log.Printf("bootstrap: could not create admin %q: %v", username, err)
		return
	}
	url, expires, err := mintSetPasswordLink(ctx, cfg, st, u.ID)
	if err != nil {
		log.Printf("bootstrap: could not mint setup link: %v", err)
		return
	}

	log.Printf("bootstrap: no admins found; created %q (id %d)", username, u.ID)
	log.Printf("bootstrap: open this one-time link to set the password (expires %s):",
		expires.Format(time.RFC1123))
	log.Printf("bootstrap:   %s", url)

	// Seed a default public channel so a brand-new instance isn't a blank
	// sidebar (and so the first arrival has somewhere to talk). Only on a truly
	// empty instance — if any channel already exists, leave the room layout
	// alone. Best-effort: a failure here never blocks startup.
	if n, err := st.CountChannels(ctx); err != nil {
		log.Printf("bootstrap: channel count check failed: %v", err)
	} else if n == 0 {
		if ch, err := st.CreateChannel(ctx, "general", "", false, u.ID); err != nil {
			log.Printf("bootstrap: could not create default #general channel: %v", err)
		} else {
			log.Printf("bootstrap: created default channel #%s (id %d)", ch.Name, ch.ID)
		}
	}
}

// mintSetPasswordLink creates a single-use set_password magic link for a user
// and returns the full URL to open along with its expiry.
func mintSetPasswordLink(ctx context.Context, cfg config.Config, st *store.Store, userID int64) (string, time.Time, error) {
	token, err := auth.NewToken()
	if err != nil {
		return "", time.Time{}, err
	}
	expires := time.Now().Add(cfg.MagicLinkTTL)
	if err := st.CreateMagicLink(ctx, userID, auth.HashToken(token), "set_password", userID, expires); err != nil {
		return "", time.Time{}, err
	}
	base := cfg.PublicURL
	if base == "" {
		base = "http://localhost" + cfg.Addr
	}
	for len(base) > 0 && base[len(base)-1] == '/' {
		base = base[:len(base)-1]
	}
	return base + "/set-password#" + token, expires, nil
}
