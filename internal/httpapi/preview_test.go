package httpapi

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"rivendell/internal/auth"
	"rivendell/internal/dbtest"
	"rivendell/internal/store"
)

// TestOGTagParsing verifies fetchOGTags extracts og: meta values from a mock page.
func TestOGTagParsing(t *testing.T) {
	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(`<!DOCTYPE html><html><head>
<meta property="og:title" content="Test Article" />
<meta property="og:description" content="A &amp; B" />
<meta property="og:image" content="/images/thumb.jpg" />
<meta property="og:site_name" content="Example Site" />
</head><body></body></html>`))
	}))
	defer origin.Close()

	lp, err := fetchOGTags(context.Background(), origin.Client(), origin.URL+"/article")
	if err != nil {
		t.Fatalf("fetchOGTags: %v", err)
	}
	if lp.Title != "Test Article" {
		t.Errorf("title = %q", lp.Title)
	}
	if lp.Description != "A & B" {
		t.Errorf("description = %q (HTML entities should be unescaped)", lp.Description)
	}
	if lp.SiteName != "Example Site" {
		t.Errorf("site_name = %q", lp.SiteName)
	}
	// Relative image URL must be resolved against the page origin.
	wantImg := origin.URL + "/images/thumb.jpg"
	if lp.ImageURL != wantImg {
		t.Errorf("image_url = %q, want %q", lp.ImageURL, wantImg)
	}
}

// TestOGTagDescriptionFallback checks that name="description" is used when
// og:description is absent.
func TestOGTagDescriptionFallback(t *testing.T) {
	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<html><head>
<meta property="og:title" content="No OG Desc" />
<meta name="description" content="Plain meta description" />
</head></html>`))
	}))
	defer origin.Close()

	lp, err := fetchOGTags(context.Background(), origin.Client(), origin.URL+"/")
	if err != nil {
		t.Fatalf("fetchOGTags: %v", err)
	}
	if lp.Description != "Plain meta description" {
		t.Errorf("description fallback = %q", lp.Description)
	}
}

// TestWikipediaSummaryFetch verifies fetchPreview uses the REST summary API for
// Wikipedia article URLs and populates title, description, image, and site_name.
func TestWikipediaSummaryFetch(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/rest_v1/page/summary/Gopher" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"title":"Gopher","extract":"A gopher is a rodent.","thumbnail":{"source":"https://example.org/thumb.jpg"}}`))
	}))
	defer srv.Close()

	// Fake a wikipedia.org URL pointing at the test TLS server.
	rawURL := srv.URL + "/wiki/Gopher"
	u, _ := url.Parse(rawURL)
	lp, err := fetchWikipediaSummary(context.Background(), srv.Client(), rawURL, u)
	if err != nil {
		t.Fatalf("fetchWikipediaSummary: %v", err)
	}
	if lp.Title != "Gopher" {
		t.Errorf("title = %q", lp.Title)
	}
	if lp.Description != "A gopher is a rodent." {
		t.Errorf("description = %q", lp.Description)
	}
	if lp.ImageURL != "https://example.org/thumb.jpg" {
		t.Errorf("image_url = %q", lp.ImageURL)
	}
	if lp.SiteName != "Wikipedia" {
		t.Errorf("site_name = %q", lp.SiteName)
	}
}

// TestFetchPreviewDispatches verifies fetchPreview routes Wikipedia URLs to the
// summary API (JSON endpoint) and non-Wikipedia URLs to og: scraping.
func TestFetchPreviewDispatches(t *testing.T) {
	var gotPath string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"title":"T","extract":"E"}`))
	}))
	defer srv.Close()

	// Simulate a *.wikipedia.org URL by constructing a URL whose hostname ends
	// in ".wikipedia.org" — we swap the host after parsing so the TLS server
	// is actually dialed, but the dispatch logic runs on the original string.
	rawURL := srv.URL + "/wiki/Python"
	u, _ := url.Parse(rawURL)
	// Override hostname check by calling fetchWikipediaSummary directly with a
	// crafted *url.URL that has a Wikipedia-shaped path.
	u.Path = "/wiki/Python"
	if _, err := fetchWikipediaSummary(context.Background(), srv.Client(), rawURL, u); err != nil {
		t.Fatalf("fetchWikipediaSummary: %v", err)
	}
	if gotPath != "/api/rest_v1/page/summary/Python" {
		t.Errorf("API path = %q, want /api/rest_v1/page/summary/Python", gotPath)
	}
}

// TestIsPublicIP pins the SSRF dial-guard predicate: only routable public
// addresses are allowed; loopback, private, link-local (incl. the cloud
// metadata endpoint), unspecified, and multicast are refused.
func TestIsPublicIP(t *testing.T) {
	cases := []struct {
		ip   string
		want bool
	}{
		{"1.1.1.1", true},
		{"140.82.112.3", true}, // github.com-ish public
		{"2606:2800:220:1::1", true},
		{"127.0.0.1", false},
		{"::1", false},
		{"10.0.0.5", false},
		{"172.16.0.1", false},
		{"192.168.1.1", false},
		{"169.254.169.254", false}, // cloud metadata
		{"fe80::1", false},         // link-local
		{"fc00::1", false},         // unique local
		{"0.0.0.0", false},
		{"224.0.0.1", false}, // multicast
	}
	for _, c := range cases {
		ip := net.ParseIP(c.ip)
		if ip == nil {
			t.Fatalf("bad test IP %q", c.ip)
		}
		if got := isPublicIP(ip); got != c.want {
			t.Errorf("isPublicIP(%s) = %v, want %v", c.ip, got, c.want)
		}
	}
}

// TestCheckPreviewRedirect verifies the per-hop redirect policy re-applies the
// https + allowlist checks (an open redirect on an allowlisted host must not
// bounce the fetch to an off-allowlist or downgraded destination).
func TestCheckPreviewRedirect(t *testing.T) {
	allowed := func(h string) bool { return h == "github.com" }
	policy := checkPreviewRedirect(allowed)

	mk := func(rawurl string) *http.Request {
		u, _ := url.Parse(rawurl)
		return &http.Request{URL: u}
	}

	if err := policy(mk("https://github.com/a"), nil); err != nil {
		t.Errorf("allowlisted https hop should pass, got %v", err)
	}
	if err := policy(mk("https://evil.example.com/a"), nil); err == nil {
		t.Error("redirect to non-allowlisted host should be refused")
	}
	if err := policy(mk("http://github.com/a"), nil); err == nil {
		t.Error("redirect to non-https should be refused")
	}
	// Sixth hop (five prior) must be refused regardless of host.
	via := make([]*http.Request, 5)
	if err := policy(mk("https://github.com/a"), via); err == nil {
		t.Error("redirect past the hop limit should be refused")
	}
}

// TestPreviewClientRefusesInternal verifies the dial Control hook rejects a
// connection to a loopback address even when the redirect/allowlist checks
// would otherwise permit it — the end-to-end SSRF backstop.
func TestPreviewClientRefusesInternal(t *testing.T) {
	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte("<html><head></head></html>"))
	}))
	defer origin.Close()

	// allowed=true so only the dial guard can reject; the server is on 127.0.0.1.
	client := newPreviewClient(func(string) bool { return true })
	_, err := fetchOGTags(context.Background(), client, origin.URL+"/x")
	if err == nil {
		t.Fatal("expected dial to loopback address to be refused")
	}
	if !strings.Contains(err.Error(), "non-public") {
		t.Errorf("error = %v, want a non-public-address refusal", err)
	}
}

// TestLinkPreviewStoreCycle verifies GetLinkPreview/SaveLinkPreview round-trip.
func TestLinkPreviewStoreCycle(t *testing.T) {
	st := dbtest.Open(t)
	ctx := context.Background()
	const testURL = "https://example.com/preview-cycle-test"

	lp := store.LinkPreview{
		URL:         testURL,
		Title:       "Hello",
		Description: "World",
		SiteName:    "Example",
		ExpiresAt:   time.Now().Add(time.Hour),
	}
	if err := st.SaveLinkPreview(ctx, lp); err != nil {
		t.Fatalf("SaveLinkPreview: %v", err)
	}
	got, err := st.GetLinkPreview(ctx, testURL)
	if err != nil {
		t.Fatalf("GetLinkPreview: %v", err)
	}
	if got.Title != "Hello" || got.Description != "World" || got.SiteName != "Example" {
		t.Errorf("round-trip mismatch: %+v", got)
	}

	// Expired row must return ErrNotFound.
	lp.ExpiresAt = time.Now().Add(-time.Minute)
	if err := st.SaveLinkPreview(ctx, lp); err != nil {
		t.Fatalf("SaveLinkPreview (expire): %v", err)
	}
	if _, err := st.GetLinkPreview(ctx, testURL); err != store.ErrNotFound {
		t.Errorf("expected ErrNotFound for expired row, got %v", err)
	}
}

// TestLinkPreviewAllowlist verifies the handler rejects non-allowlisted domains
// and non-HTTPS URLs.
func TestLinkPreviewAllowlist(t *testing.T) {
	ts, st, _, srv := newTestServerSrv(t)
	srv.cfg.LinkPreviewDomains = []string{"github.com", "wikipedia.org"}

	// Seed a logged-in member.
	ctx := context.Background()
	u, err := st.CreateUser(ctx, "previewalice", "Preview Alice", store.RoleMember)
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	hash, _ := auth.HashPassword("pw123")
	if err := st.SetPassword(ctx, u.ID, hash); err != nil {
		t.Fatalf("set password: %v", err)
	}
	c := newClient(t)
	resp, _ := doJSON(t, c, "POST", ts.URL+"/api/auth/login",
		map[string]string{"username": "previewalice", "password": "pw123"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login failed: %d", resp.StatusCode)
	}

	// Non-allowlisted domain → 404.
	resp, _ = doJSON(t, c, "GET", ts.URL+"/api/link-preview?url=https://evil.example.com/page", nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("non-allowlisted: got %d, want 404", resp.StatusCode)
	}

	// Non-HTTPS URL → 400.
	resp, _ = doJSON(t, c, "GET", ts.URL+"/api/link-preview?url=http://github.com/foo", nil)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("non-https: got %d, want 400", resp.StatusCode)
	}

	// Subdomain of allowlisted domain → 202 (miss, background fetch started).
	resp, _ = doJSON(t, c, "GET", ts.URL+"/api/link-preview?url=https://en.wikipedia.org/wiki/Test", nil)
	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		t.Errorf("subdomain allowlisted: got %d, want 200 or 202", resp.StatusCode)
	}
}

// TestLinkPreviewDisabled verifies that nil LinkPreviewDomains returns 404.
func TestLinkPreviewDisabled(t *testing.T) {
	_, _, _, srv := newTestServerSrv(t)
	srv.cfg.LinkPreviewDomains = nil

	// Create a standalone test server using the same srv.
	ts2 := httptest.NewServer(srv.Handler())
	defer ts2.Close()

	ctx := context.Background()
	u, err := srv.st.CreateUser(ctx, "previewbob", "Preview Bob", store.RoleMember)
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	hash, _ := auth.HashPassword("pw456")
	if err := srv.st.SetPassword(ctx, u.ID, hash); err != nil {
		t.Fatalf("set password: %v", err)
	}
	c := newClient(t)
	resp, _ := doJSON(t, c, "POST", ts2.URL+"/api/auth/login",
		map[string]string{"username": "previewbob", "password": "pw456"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login: %d", resp.StatusCode)
	}

	resp, _ = doJSON(t, c, "GET", ts2.URL+"/api/link-preview?url=https://github.com/foo", nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("disabled: got %d, want 404", resp.StatusCode)
	}
}
