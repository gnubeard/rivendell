package httpapi

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rivendell/internal/config"
)

// TestStaticTemplatesAllJSModules guards the fix for the duplicate-module-instance
// bug: every served .js (not just app.js) must have its __RIVENDELL_VERSION__
// placeholder rewritten, so app.js and a sibling that both import the same module
// resolve to one URL — one instance. A regression here silently splits a stateful
// module (e.g. secret.js) into two instances with unshared state.
func TestStaticTemplatesAllJSModules(t *testing.T) {
	ts, _, cfg, _ := newTestServerSrv(t)

	// A non-app.js module that imports a sibling via the cache-bust suffix.
	const body = `import { x } from "./secret.js?v=__RIVENDELL_VERSION__";`
	if err := os.WriteFile(filepath.Join(cfg.WebDir, "secretui.js"), []byte(body), 0o644); err != nil {
		t.Fatalf("write module: %v", err)
	}

	// Versioned request: placeholder rewritten, response immutable.
	resp, err := http.Get(ts.URL + "/secretui.js?v=" + config.Version)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	if strings.Contains(string(got), versionPlaceholder) {
		t.Errorf("secretui.js still contains %s — placeholder not rewritten in a non-app.js module", versionPlaceholder)
	}
	want := "./secret.js?v=" + config.Version
	if !strings.Contains(string(got), want) {
		t.Errorf("secretui.js import not rewritten to %q; got: %s", want, got)
	}
	if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Errorf("versioned module Cache-Control = %q, want immutable", cc)
	}
}

// TestStaticUnversionedJSRevalidates: a .js fetched without ?v (e.g. /sw.js) is
// still templated but must NOT be cached immutable, or a new build never reaches
// clients that load it unversioned.
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
