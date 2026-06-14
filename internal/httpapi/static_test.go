package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rivendell/internal/config"
)

// TestVersionedModulesServedRawAndImmutable guards the single-instance contract
// after the move to path-based cache-busting: a module is served verbatim under
// /v/<version>/, its relative imports left untouched so they resolve under the
// same versioned prefix (one URL per module per page load = one instance), and
// the response is cacheable as immutable.
func TestVersionedModulesServedRawAndImmutable(t *testing.T) {
	ts, _, cfg, _ := newTestServerSrv(t)

	// A module importing a sibling via a bare relative specifier (no cache-bust
	// suffix — the prefix carries the version now).
	const body = `import { x } from "./secret.js";`
	if err := os.WriteFile(filepath.Join(cfg.WebDir, "secretui.js"), []byte(body), 0o644); err != nil {
		t.Fatalf("write module: %v", err)
	}

	resp, err := http.Get(ts.URL + "/v/" + config.Version + "/secretui.js")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	// Served raw: the relative import survives so it resolves to
	// /v/<version>/secret.js (same prefix), keeping module identity stable.
	if string(got) != body {
		t.Errorf("module not served verbatim;\n got: %q\nwant: %q", got, body)
	}
	if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Errorf("versioned module Cache-Control = %q, want immutable", cc)
	}
}

// TestVersionedStaticIgnoresVersionValue: the <version> segment is a pure cache
// key, so any value resolves to the current file (an old in-flight page still
// loads), and the prefix maps back to the same on-disk path handleStatic uses.
func TestVersionedStaticIgnoresVersionValue(t *testing.T) {
	ts, _, cfg, _ := newTestServerSrv(t)
	if err := os.WriteFile(filepath.Join(cfg.WebDir, "app.js"), []byte("export const v = 1;"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	resp, err := http.Get(ts.URL + "/v/some-stale-version/app.js")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("stale version segment status = %d, want 200 (version is just a cache key)", resp.StatusCode)
	}
}

// TestVersionedStaticRejectsTraversal: the version-stripped path must stay inside
// WebDir. Called directly (not through the mux, which would pre-clean the dotted
// path) so the handler's own guard is exercised.
func TestVersionedStaticRejectsTraversal(t *testing.T) {
	_, _, _, srv := newTestServerSrv(t)
	req := httptest.NewRequest("GET", "/v/x/../../../etc/passwd", nil)
	rec := httptest.NewRecorder()
	srv.handleVersionedStatic(rec, req)
	if rec.Code == http.StatusOK {
		t.Errorf("traversal returned 200, want a 4xx")
	}
}

// TestIndexReferencesVersionedEntry: index.html must load the module entry from
// the versioned path (so the whole module graph is cache-busted) and still have
// its version/instance placeholders rewritten.
func TestIndexReferencesVersionedEntry(t *testing.T) {
	ts, _, cfg, _ := newTestServerSrv(t)
	const html = `<script type="module" src="/v/__RIVENDELL_VERSION__/static/app.js"></script>`
	if err := os.WriteFile(filepath.Join(cfg.WebDir, "index.html"), []byte(html), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	want := "/v/" + config.Version + "/static/app.js"
	if !strings.Contains(string(got), want) {
		t.Errorf("index.html entry not pointing at versioned path %q; got: %s", want, got)
	}
	if strings.Contains(string(got), versionPlaceholder) {
		t.Errorf("index.html still contains %s — placeholder not rewritten", versionPlaceholder)
	}
}

// TestStaticUnversionedJSRevalidates: a .js fetched without a version prefix
// (e.g. /sw.js) is still templated but must NOT be cached immutable, or a new
// build never reaches clients that load it unversioned.
func TestStaticUnversionedJSRevalidates(t *testing.T) {
	ts, _, cfg, _ := newTestServerSrv(t)
	if err := os.WriteFile(filepath.Join(cfg.WebDir, "sw.js"), []byte("// v=__RIVENDELL_VERSION__\n"), 0o644); err != nil {
		t.Fatalf("write sw: %v", err)
	}

	resp, err := http.Get(ts.URL + "/sw.js")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	if strings.Contains(string(got), versionPlaceholder) {
		t.Errorf("sw.js placeholder not rewritten")
	}
	if cc := resp.Header.Get("Cache-Control"); strings.Contains(cc, "immutable") {
		t.Errorf("unversioned /sw.js Cache-Control = %q, must not be immutable", cc)
	}
}
