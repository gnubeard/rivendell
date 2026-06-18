// Package config loads runtime configuration from environment variables.
// No config-file library, no flags framework: just os.Getenv with sane
// defaults so the binary is trivial to reason about and to run in a container.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Version is the running build's semantic version. It's surfaced via
// GET /api/instance and the About dialog. Bump it on each release.
const Version = "2.0.22"

type Config struct {
	Addr               string        // listen address, e.g. ":8080"
	DatabaseURL        string        // postgres connection string
	SessionTTL         time.Duration // how long a login session lasts
	MagicLinkTTL       time.Duration // how long a set/reset link is valid
	WebDir             string        // path to static web assets
	Secure             bool          // set Secure flag on cookies (true behind TLS)
	PublicURL          string        // base URL used to build magic links for the admin to copy
	MaxMessageBytes    int           // reject messages larger than this
	MaxAvatarBytes     int           // reject avatar uploads larger than this
	MaxImageBytes      int           // reject image uploads (POST /api/uploads) larger than this
	BlobsDir           string        // directory for content-addressed blob storage
	BootstrapAdmin     string        // username created on first boot if no admins exist
	InstanceName       string        // display name of this instance (e.g. "rivendell")
	StunURL            string        // STUN server URL for WebRTC NAT traversal
	TurnURL            string        // TURN relay URL(s), comma-separated (empty = STUN only)
	TurnSecret         string        // shared HMAC secret for time-limited TURN credentials
	VapidSubject       string        // VAPID `sub` claim for Web Push (mailto: or https URL)
	DebugTelemetry     bool          // enable POST /api/debug/telemetry + advertise capture to clients
	MaxVoiceAudio      int           // hard cap on participants in one voice channel (group calls)
	MaxVoiceVideo      int           // sub-cap on simultaneous cameras-on; over it ⇒ audio-only
	LinkPreviewDomains []string      // allowlisted hostnames for the link-preview proxy; nil = disabled
}

func Load() (Config, error) {
	c := Config{
		Addr:            env("RIVENDELL_ADDR", ":8080"),
		DatabaseURL:     env("RIVENDELL_DATABASE_URL", ""),
		WebDir:          env("RIVENDELL_WEB_DIR", "web"),
		PublicURL:       env("RIVENDELL_PUBLIC_URL", "http://localhost:8080"),
		Secure:          envBool("RIVENDELL_COOKIE_SECURE", false),
		SessionTTL:      envDur("RIVENDELL_SESSION_TTL", 30*24*time.Hour),
		MagicLinkTTL:    envDur("RIVENDELL_MAGIC_LINK_TTL", 72*time.Hour),
		MaxMessageBytes: envInt("RIVENDELL_MAX_MESSAGE_BYTES", 8000),
		MaxAvatarBytes:  envInt("RIVENDELL_MAX_AVATAR_BYTES", 512*1024),
		MaxImageBytes:   envInt("RIVENDELL_MAX_IMAGE_BYTES", 5*1024*1024),
		BlobsDir:        env("RIVENDELL_BLOBS_DIR", "blobs"),
		BootstrapAdmin:  env("RIVENDELL_BOOTSTRAP_ADMIN", "admin"),
		InstanceName:    env("RIVENDELL_INSTANCE_NAME", "rivendell"),
		StunURL:         env("RIVENDELL_STUN_URL", "stun:stun.l.google.com:19302"),
		TurnURL:         env("RIVENDELL_TURN_URL", ""),
		TurnSecret:      env("RIVENDELL_TURN_SECRET", ""),
		VapidSubject:    env("RIVENDELL_VAPID_SUBJECT", ""),
		DebugTelemetry:  envBool("RIVENDELL_DEBUG_TELEMETRY", false),
		MaxVoiceAudio:   envInt("RIVENDELL_MAX_VOICE_AUDIO", 10),
		MaxVoiceVideo:   envInt("RIVENDELL_MAX_VOICE_VIDEO", 6),
		LinkPreviewDomains: envStringList("RIVENDELL_LINK_PREVIEW_DOMAINS", []string{
			"github.com",
			"wikipedia.org",
			"cnn.com",
			"bbc.com",
			"bbc.co.uk",
			"nytimes.com",
			"theguardian.com",
			"arstechnica.com",
			"wired.com",
			"techcrunch.com",
			"twitter.com",
			"x.com",
			"theatlantic.com",
			"apnews.com",
			"nature.com",
		}),
	}
	// Default the VAPID subject to the public URL (a valid `sub` per RFC 8292) so
	// push works out of the box; operators can override with a mailto:.
	if c.VapidSubject == "" {
		c.VapidSubject = c.PublicURL
	}
	if c.DatabaseURL == "" {
		return c, fmt.Errorf("config: RIVENDELL_DATABASE_URL is required")
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

// envStringList parses a comma-separated env var into a string slice.
// Empty env var → use def. Value "off" → return nil (disabled).
func envStringList(k string, def []string) []string {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	if strings.ToLower(v) == "off" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
