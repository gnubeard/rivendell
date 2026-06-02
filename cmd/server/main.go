// Command server is the Snug chat server entrypoint. It loads configuration
// from the environment, runs database migrations, and serves the HTTP API plus
// the static web client.
//
// Bootstrap the first admin with:
//
//	snug -create-admin alice "Alice Example"
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

	"snug/internal/auth"
	"snug/internal/config"
	"snug/internal/httpapi"
	"snug/internal/store"
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

	hs := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: long-lived websocket connections live on this server.
	}
	log.Printf("snug listening on %s (web dir %s)", cfg.Addr, cfg.WebDir)
	if err := hs.ListenAndServe(); err != nil {
		log.Fatalf("server: %v", err)
	}
}

func runCreateAdmin(ctx context.Context, cfg config.Config, st *store.Store, args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: snug -create-admin <username> [display name]")
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

	token, err := auth.NewToken()
	if err != nil {
		log.Fatalf("token: %v", err)
	}
	expires := time.Now().Add(cfg.MagicLinkTTL)
	if err := st.CreateMagicLink(ctx, u.ID, auth.HashToken(token), "set_password", u.ID, expires); err != nil {
		log.Fatalf("create magic link: %v", err)
	}

	base := cfg.PublicURL
	if base == "" {
		base = "http://localhost" + cfg.Addr
	}
	for len(base) > 0 && base[len(base)-1] == '/' {
		base = base[:len(base)-1]
	}

	fmt.Println()
	fmt.Printf("Created admin %q (id %d).\n", username, u.ID)
	fmt.Println("Open this one-time link to set the password:")
	fmt.Println()
	fmt.Printf("  %s/set-password#%s\n", base, token)
	fmt.Println()
	fmt.Printf("Link expires %s.\n", expires.Format(time.RFC1123))
}
