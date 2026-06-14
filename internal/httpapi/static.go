package httpapi

import (
	"crypto/sha256"
	"fmt"
	"html"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"rivendell/internal/config"
)

// --- static files --------------------------------------------------------

// instanceNamePlaceholder is the token in index.html replaced with the
// configured instance name at serve time (so non-JS scrapers see the brand).
const instanceNamePlaceholder = "__RIVENDELL_INSTANCE__"

// versionPlaceholder is replaced with the running version at serve time. It
// now survives in only two templated files: index.html (the module entry's
// `/v/<version>/…` path + the style.css cache-bust) and sw.js (a comment whose
// bytes change so the browser re-installs the worker on a new build).
//
// The ES-module client is cache-busted by PATH, not by this token: the entry
// loads from `/v/<version>/static/app.js` and every relative import stays under
// that prefix, so one page load resolves each module to exactly one URL = one
// instance (the single-instance guarantee for stateful modules like secret.js).
// Module source files therefore carry no placeholder and are served raw — see
// handleVersionedStatic. A bumped version changes the prefix => all module URLs
// change at once => a clean cache miss.
const versionPlaceholder = "__RIVENDELL_VERSION__"

// handleVersionedStatic serves `/v/<version>/<path>` by stripping the version
// segment and serving the underlying static file raw, with an immutable cache.
// <version> is a pure cache key — its value is ignored, so an old in-flight page
// importing `/v/<old>/static/api.js` still gets the current file; consistency
// within a single page load is guaranteed because all of its imports share one
// prefix. Stripping the prefix yields the exact path handleStatic maps to disk,
// so this works identically in prod (`/v/X/static/app.js` → WebDir/static/app.js)
// and in tests (`/v/X/foo.js` → WebDir/foo.js).
func (s *Server) handleVersionedStatic(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v/")
	slash := strings.IndexByte(rest, '/')
	if slash < 0 {
		http.NotFound(w, r)
		return
	}
	logical := filepath.Clean(rest[slash:]) // drop the version segment, keep the path
	full := filepath.Join(s.cfg.WebDir, logical)
	// Prevent path traversal outside WebDir (mirrors handleStatic).
	if !strings.HasPrefix(full, filepath.Clean(s.cfg.WebDir)) {
		http.NotFound(w, r)
		return
	}
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	// Versioned path => this exact response is immutable; a version bump changes
	// the URL. No templating: module sources carry no placeholder.
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeFile(w, r, full)
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	clean := filepath.Clean(r.URL.Path)
	if clean == "/" {
		clean = "/index.html"
	}
	full := filepath.Join(s.cfg.WebDir, clean)
	// Prevent path traversal outside WebDir.
	if !strings.HasPrefix(full, filepath.Clean(s.cfg.WebDir)) {
		http.NotFound(w, r)
		return
	}
	base := filepath.Base(full)
	// .js served here is /sw.js (templated: its placeholder comment re-installs
	// the worker on a new build) — and, defensively, any unversioned legacy
	// module path, for which the rewrite is a harmless no-op. The real module
	// entry loads via /v/<version>/ (handleVersionedStatic), not here.
	if strings.HasSuffix(base, ".js") {
		s.serveTemplated(w, r, full, "application/javascript; charset=utf-8")
		return
	}
	if info, err := os.Stat(full); err == nil && !info.IsDir() && base != "index.html" {
		http.ServeFile(w, r, full)
		return
	}
	s.serveIndex(w, r)
}

func (s *Server) serveIndex(w http.ResponseWriter, r *http.Request) {
	s.serveTemplated(w, r, filepath.Join(s.cfg.WebDir, "index.html"), "text/html; charset=utf-8")
}

func (s *Server) serveTemplated(w http.ResponseWriter, r *http.Request, path, contentType string) {
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	out := strings.ReplaceAll(string(data), instanceNamePlaceholder, html.EscapeString(s.cfg.InstanceName))
	out = strings.ReplaceAll(out, versionPlaceholder, config.Version)
	etag := fmt.Sprintf(`"%x"`, sha256.Sum256([]byte(out)))
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("ETag", etag)
	if r.URL.Query().Has("v") {
		// Versioned URL (?v=X) — module imports always carry it, so this exact
		// response is immutable; a version bump changes the URL.
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	} else {
		// Unversioned (index.html, /sw.js) must revalidate to pick up new
		// references, but can short-circuit with a 304 via ETag.
		w.Header().Set("Cache-Control", "no-cache, private")
	}
	w.Header().Set("Content-Type", contentType)
	_, _ = w.Write([]byte(out))
}
