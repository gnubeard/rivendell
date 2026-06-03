// Package config loads runtime configuration from environment variables.
// No config-file library, no flags framework: just os.Getenv with sane
// defaults so the binary is trivial to reason about and to run in a container.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Addr            string        // listen address, e.g. ":8080"
	DatabaseURL     string        // postgres connection string
	SessionTTL      time.Duration // how long a login session lasts
	MagicLinkTTL    time.Duration // how long a set/reset link is valid
	WebDir          string        // path to static web assets
	Secure          bool          // set Secure flag on cookies (true behind TLS)
	PublicURL       string        // base URL used to build magic links for the admin to copy
	MaxMessageBytes int           // reject messages larger than this
	MaxAvatarBytes  int           // reject avatar uploads larger than this
	BootstrapAdmin  string        // username created on first boot if no admins exist
	InstanceName    string        // display name of this instance (e.g. "rivendell")
}

func Load() (Config, error) {
	c := Config{
		Addr:            env("SNUG_ADDR", ":8080"),
		DatabaseURL:     env("SNUG_DATABASE_URL", "postgres://chat:chat_dev_pw@localhost:5432/chat?sslmode=disable"),
		WebDir:          env("SNUG_WEB_DIR", "web"),
		PublicURL:       env("SNUG_PUBLIC_URL", "http://localhost:8080"),
		Secure:          envBool("SNUG_COOKIE_SECURE", false),
		SessionTTL:      envDur("SNUG_SESSION_TTL", 30*24*time.Hour),
		MagicLinkTTL:    envDur("SNUG_MAGIC_LINK_TTL", 72*time.Hour),
		MaxMessageBytes: envInt("SNUG_MAX_MESSAGE_BYTES", 8000),
		MaxAvatarBytes:  envInt("SNUG_MAX_AVATAR_BYTES", 512*1024),
		BootstrapAdmin:  env("SNUG_BOOTSTRAP_ADMIN", "admin"),
		InstanceName:    env("SNUG_INSTANCE_NAME", "snug"),
	}
	if c.DatabaseURL == "" {
		return c, fmt.Errorf("config: SNUG_DATABASE_URL is required")
	}
	return c, nil
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envBool(k string, def bool) bool {
	if v := os.Getenv(k); v != "" {
		b, err := strconv.ParseBool(v)
		if err == nil {
			return b
		}
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		n, err := strconv.Atoi(v)
		if err == nil {
			return n
		}
	}
	return def
}

func envDur(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		d, err := time.ParseDuration(v)
		if err == nil {
			return d
		}
	}
	return def
}
