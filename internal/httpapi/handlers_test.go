package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"snug/internal/auth"
	"snug/internal/config"
	"snug/internal/store"
)

// testDSN returns the test database connection string, or "" to skip.
func testDSN() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://chat:chat_dev_pw@localhost:5432/chat_test?sslmode=disable"
}

func newTestServer(t *testing.T) (*httptest.Server, *store.Store, config.Config) {
	t.Helper()
	dsn := testDSN()
	st, err := store.Open(context.Background(), dsn)
	if err != nil {
		t.Skipf("no test database (%v); set TEST_DATABASE_URL to run", err)
	}
	if err := st.Migrate(context.Background()); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	// Clean slate.
	_, err = st.DB().Exec(`TRUNCATE messages, channel_members, channels, magic_links, sessions, users RESTART IDENTITY CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
	cfg := config.Config{
		Addr:            ":0",
		SessionTTL:      time.Hour,
		MagicLinkTTL:    time.Hour,
		Secure:          false,
		PublicURL:       "http://snug.test",
		MaxMessageBytes: 4096,
		MaxAvatarBytes:  1 << 20,
		WebDir:          t.TempDir(),
	}
	srv := New(cfg, st)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() {
		ts.Close()
		st.Close()
	})
	return ts, st, cfg
}

// client carries a cookie jar so sessions persist across requests.
func newClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Jar: jar}
}

func doJSON(t *testing.T, c *http.Client, method, url string, body any) (*http.Response, []byte) {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	buf := new(bytes.Buffer)
	_, _ = buf.ReadFrom(resp.Body)
	return resp, buf.Bytes()
}

// seedAdmin creates an admin directly in the store and returns a logged-in client.
func seedAdmin(t *testing.T, ts *httptest.Server, st *store.Store) (*http.Client, store.User) {
	t.Helper()
	ctx := context.Background()
	u, err := st.CreateUser(ctx, "admin", "Admin", store.RoleAdmin)
	if err != nil {
		t.Fatalf("create admin: %v", err)
	}
	hash, _ := auth.HashPassword("supersecret123")
	if err := st.SetPassword(ctx, u.ID, hash); err != nil {
		t.Fatalf("set password: %v", err)
	}
	c := newClient(t)
	resp, body := doJSON(t, c, "POST", ts.URL+"/api/auth/login", map[string]string{
		"username": "admin", "password": "supersecret123",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("admin login failed: %d %s", resp.StatusCode, body)
	}
	u.HasPassword = true
	return c, u
}

func TestEmptyListsReturnArraysNotNull(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)

	// A fresh install has no channels; the body must be "[]", never "null",
	// or the client's for...of iteration throws and the whole UI fails to wire.
	resp, body := doJSON(t, adminC, "GET", ts.URL+"/api/channels", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("channels: %d", resp.StatusCode)
	}
	if strings.TrimSpace(string(body)) != "[]" {
		t.Fatalf("empty channels must serialize as [], got %q", string(body))
	}

	// Same contract for messages in a brand-new empty channel.
	resp, body = doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create channel: %d %s", resp.StatusCode, body)
	}
	var ch store.Channel
	json.Unmarshal(body, &ch)
	resp, body = doJSON(t, adminC, "GET", ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("messages: %d", resp.StatusCode)
	}
	if strings.TrimSpace(string(body)) != "[]" {
		t.Fatalf("empty messages must serialize as [], got %q", string(body))
	}
}

func TestHealth(t *testing.T) {
	ts, _, _ := newTestServer(t)
	c := newClient(t)
	resp, body := doJSON(t, c, "GET", ts.URL+"/api/health", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("health: got %d, body %s", resp.StatusCode, body)
	}
}

func TestUnauthenticatedRejected(t *testing.T) {
	ts, _, _ := newTestServer(t)
	c := newClient(t)
	resp, _ := doJSON(t, c, "GET", ts.URL+"/api/me", nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestLoginWrongPassword(t *testing.T) {
	ts, st, _ := newTestServer(t)
	seedAdmin(t, ts, st)
	c := newClient(t)
	resp, _ := doJSON(t, c, "POST", ts.URL+"/api/auth/login", map[string]string{
		"username": "admin", "password": "wrong",
	})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

// TestMagicLinkFlow drives the whole bootstrap path: admin creates a user, mints
// a magic link, the user peeks it, sets a password, and is auto-logged-in.
func TestMagicLinkFlow(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)

	// Admin creates a member.
	resp, body := doJSON(t, adminC, "POST", ts.URL+"/api/admin/users", map[string]string{
		"username": "bob", "display_name": "Bob",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create user: %d %s", resp.StatusCode, body)
	}
	var created store.User
	json.Unmarshal(body, &created)

	// Admin mints a magic link.
	resp, body = doJSON(t, adminC, "POST", ts.URL+"/api/admin/users/"+itoa(created.ID)+"/magic-link", nil)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("magic link: %d %s", resp.StatusCode, body)
	}
	var link struct {
		URL     string `json:"url"`
		Token   string `json:"token"`
		Purpose string `json:"purpose"`
	}
	json.Unmarshal(body, &link)
	if link.Purpose != "set_password" {
		t.Fatalf("expected set_password, got %q", link.Purpose)
	}
	if !strings.Contains(link.URL, link.Token) {
		t.Fatalf("url %q missing token", link.URL)
	}

	// New user peeks the link (unauthenticated).
	userC := newClient(t)
	resp, body = doJSON(t, userC, "GET", ts.URL+"/api/auth/magic/"+link.Token, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("peek: %d %s", resp.StatusCode, body)
	}

	// New user sets password -> auto-login.
	resp, body = doJSON(t, userC, "POST", ts.URL+"/api/auth/set-password", map[string]string{
		"token": link.Token, "password": "bobs-strong-pw",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("set-password: %d %s", resp.StatusCode, body)
	}

	// Cookie should now be valid.
	resp, body = doJSON(t, userC, "GET", ts.URL+"/api/me", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("me after set-password: %d %s", resp.StatusCode, body)
	}
	var me store.User
	json.Unmarshal(body, &me)
	if me.Username != "bob" {
		t.Fatalf("expected bob, got %q", me.Username)
	}

	// Link is single-use: second consume must fail.
	resp, _ = doJSON(t, newClient(t), "POST", ts.URL+"/api/auth/set-password", map[string]string{
		"token": link.Token, "password": "another-pw-here",
	})
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected reused link 404, got %d", resp.StatusCode)
	}
}

func TestChannelAndMessageFlow(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)

	// Create a public channel.
	resp, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{
		"name": "general", "topic": "everything",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create channel: %d %s", resp.StatusCode, body)
	}
	var ch store.Channel
	json.Unmarshal(body, &ch)

	// Duplicate name -> 409.
	resp, _ = doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 on dup channel, got %d", resp.StatusCode)
	}

	// Post a message.
	resp, body = doJSON(t, adminC, "POST", ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages", map[string]string{
		"content": "hello **world**",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("post message: %d %s", resp.StatusCode, body)
	}
	var msg store.Message
	json.Unmarshal(body, &msg)

	// List messages.
	resp, body = doJSON(t, adminC, "GET", ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list messages: %d %s", resp.StatusCode, body)
	}
	var msgs []store.Message
	json.Unmarshal(body, &msgs)
	if len(msgs) != 1 || msgs[0].Content != "hello **world**" {
		t.Fatalf("unexpected messages: %s", body)
	}

	// Empty message rejected.
	resp, _ = doJSON(t, adminC, "POST", ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages", map[string]string{
		"content": "   ",
	})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 on empty message, got %d", resp.StatusCode)
	}
}

func TestMemberCannotCreateChannel(t *testing.T) {
	ts, st, _ := newTestServer(t)
	seedAdmin(t, ts, st)

	// Make a member directly and log in.
	ctx := context.Background()
	m, _ := st.CreateUser(ctx, "carol", "Carol", store.RoleMember)
	hash, _ := auth.HashPassword("carols-strong-pw")
	st.SetPassword(ctx, m.ID, hash)
	c := newClient(t)
	doJSON(t, c, "POST", ts.URL+"/api/auth/login", map[string]string{
		"username": "carol", "password": "carols-strong-pw",
	})

	resp, _ := doJSON(t, c, "POST", ts.URL+"/api/channels", map[string]any{"name": "secret"})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for member creating channel, got %d", resp.StatusCode)
	}
}

func TestLastAdminCannotBeDemoted(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, admin := seedAdmin(t, ts, st)

	resp, body := doJSON(t, adminC, "PUT", ts.URL+"/api/admin/users/"+itoa(admin.ID)+"/role", map[string]string{
		"role": "member",
	})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 demoting last admin, got %d %s", resp.StatusCode, body)
	}
}

func TestPrivateChannelHidden(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)

	// Admin creates a private channel.
	resp, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{
		"name": "mods-only", "is_private": true,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create private channel: %d %s", resp.StatusCode, body)
	}

	// Member should not see it in the list.
	ctx := context.Background()
	m, _ := st.CreateUser(ctx, "dave", "Dave", store.RoleMember)
	hash, _ := auth.HashPassword("daves-strong-pw")
	st.SetPassword(ctx, m.ID, hash)
	c := newClient(t)
	doJSON(t, c, "POST", ts.URL+"/api/auth/login", map[string]string{
		"username": "dave", "password": "daves-strong-pw",
	})
	resp, body = doJSON(t, c, "GET", ts.URL+"/api/channels", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list channels: %d", resp.StatusCode)
	}
	var chans []store.Channel
	json.Unmarshal(body, &chans)
	for _, ch := range chans {
		if ch.Name == "mods-only" {
			t.Fatalf("member should not see private channel")
		}
	}
}

func itoa(i int64) string {
	return strconv.FormatInt(i, 10)
}
