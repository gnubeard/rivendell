package httpapi

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"rivendell/internal/auth"
	"rivendell/internal/config"
	"rivendell/internal/store"
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
	ts, st, cfg, _ := newTestServerSrv(t)
	return ts, st, cfg
}

// newTestServerSrv is newTestServer plus the underlying *Server, for tests that
// need to inspect in-memory state (e.g. pending rings) for deterministic
// synchronisation.
func newTestServerSrv(t *testing.T) (*httptest.Server, *store.Store, config.Config, *Server) {
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
	_, err = st.DB().Exec(`TRUNCATE push_subscriptions, blobs, emojis, channel_mutes, message_mentions, channel_reads, messages, channel_members, channels, magic_links, invitations, bot_tokens, sessions, users RESTART IDENTITY CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
	cfg := config.Config{
		Addr:            ":0",
		SessionTTL:      time.Hour,
		MagicLinkTTL:    time.Hour,
		Secure:          false,
		PublicURL:       "http://rivendell.test",
		MaxMessageBytes: 4096,
		MaxAvatarBytes:  1 << 20,
		MaxImageBytes:   5 * 1024 * 1024,
		BlobsDir:        t.TempDir(),
		WebDir:          t.TempDir(),
		InstanceName:    "rivendell-test",
	}
	srv := New(cfg, st)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() {
		ts.Close()
		st.Close()
	})
	return ts, st, cfg, srv
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

	// And for the admin invitation list on a fresh install.
	resp, body = doJSON(t, adminC, "GET", ts.URL+"/api/admin/invitations", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("invitations: %d", resp.StatusCode)
	}
	if strings.TrimSpace(string(body)) != "[]" {
		t.Fatalf("empty invitations must serialize as [], got %q", string(body))
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

// TestMagicLinkFlow drives the password set/reset path (kept unchanged when the
// new-user flow moved to invitations): a member without a password exists, the
// admin mints a magic link, the user peeks it, sets a password, and is
// auto-logged-in.
func TestMagicLinkFlow(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)

	// A member exists without a password yet (e.g. the bootstrap admin path, or
	// an account whose password is being reset).
	created, err := st.CreateUser(context.Background(), "bob", "Bob", store.RoleMember)
	if err != nil {
		t.Fatalf("create user: %v", err)
	}

	// Admin mints a magic link.
	resp, body := doJSON(t, adminC, "POST", ts.URL+"/api/admin/users/"+itoa(created.ID)+"/magic-link", nil)
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

// adminCreateInvitation mints an invitation as the admin and returns the link
// fields. Fails the test on a non-201.
func adminCreateInvitation(t *testing.T, ts *httptest.Server, adminC *http.Client) (id int64, token, url string) {
	t.Helper()
	resp, body := doJSON(t, adminC, "POST", ts.URL+"/api/admin/invitations", nil)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create invitation: %d %s", resp.StatusCode, body)
	}
	var inv struct {
		ID    int64  `json:"id"`
		Token string `json:"token"`
		URL   string `json:"url"`
	}
	json.Unmarshal(body, &inv)
	if inv.ID == 0 || inv.Token == "" {
		t.Fatalf("invitation missing id/token: %s", body)
	}
	if !strings.Contains(inv.URL, inv.Token) {
		t.Fatalf("url %q missing token", inv.URL)
	}
	return inv.ID, inv.Token, inv.URL
}

// TestInvitationSignupFlow drives the new-user path: an admin issues an
// invitation, a new person validates it and signs up choosing their own
// username, lands as a logged-in member with the display name seeded from the
// username, and the invitation is consumed (single-use).
func TestInvitationSignupFlow(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)

	id, token, _ := adminCreateInvitation(t, ts, adminC)

	// It shows up in the admin list as pending (not yet used).
	resp, body := doJSON(t, adminC, "GET", ts.URL+"/api/admin/invitations", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list invitations: %d %s", resp.StatusCode, body)
	}
	var invites []store.Invitation
	json.Unmarshal(body, &invites)
	if len(invites) != 1 || invites[0].ID != id || invites[0].UsedAt != nil {
		t.Fatalf("expected one pending invitation, got %s", body)
	}

	// New user validates the link (unauthenticated).
	userC := newClient(t)
	resp, body = doJSON(t, userC, "GET", ts.URL+"/api/auth/invitation/"+token, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("check invitation: %d %s", resp.StatusCode, body)
	}

	// New user signs up -> auto-login.
	resp, body = doJSON(t, userC, "POST", ts.URL+"/api/auth/signup", map[string]string{
		"token": token, "username": "Frodo", "password": "ringbearer-pw",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup: %d %s", resp.StatusCode, body)
	}
	var created store.User
	json.Unmarshal(body, &created)
	if created.Username != "frodo" { // lower-cased
		t.Fatalf("expected username frodo, got %q", created.Username)
	}
	if created.DisplayName != "frodo" {
		t.Fatalf("display name should default to username, got %q", created.DisplayName)
	}
	if created.Role != store.RoleMember {
		t.Fatalf("new user should be a member, got %q", created.Role)
	}
	if !created.HasPassword {
		t.Fatalf("new user should have a password set")
	}

	// Cookie is valid (auto-logged-in).
	resp, body = doJSON(t, userC, "GET", ts.URL+"/api/me", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("me after signup: %d %s", resp.StatusCode, body)
	}

	// Invitation is consumed: peek now 404, reuse now 404, list shows used_by.
	resp, _ = doJSON(t, newClient(t), "GET", ts.URL+"/api/auth/invitation/"+token, nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected consumed invitation peek 404, got %d", resp.StatusCode)
	}
	resp, _ = doJSON(t, newClient(t), "POST", ts.URL+"/api/auth/signup", map[string]string{
		"token": token, "username": "sam", "password": "samwise-pw-12",
	})
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected reused invitation 404, got %d", resp.StatusCode)
	}
	resp, body = doJSON(t, adminC, "GET", ts.URL+"/api/admin/invitations", nil)
	json.Unmarshal(body, &invites)
	if len(invites) != 1 || invites[0].UsedAt == nil || invites[0].UsedBy == nil || *invites[0].UsedBy != created.ID {
		t.Fatalf("expected invitation used by %d, got %s", created.ID, body)
	}
}

// TestInvitationRevoke checks an admin can revoke an unused invitation, after
// which the link no longer validates or redeems.
func TestInvitationRevoke(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)

	id, token, _ := adminCreateInvitation(t, ts, adminC)

	resp, body := doJSON(t, adminC, "DELETE", ts.URL+"/api/admin/invitations/"+itoa(id), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete invitation: %d %s", resp.StatusCode, body)
	}

	resp, _ = doJSON(t, newClient(t), "GET", ts.URL+"/api/auth/invitation/"+token, nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected revoked peek 404, got %d", resp.StatusCode)
	}
	resp, _ = doJSON(t, newClient(t), "POST", ts.URL+"/api/auth/signup", map[string]string{
		"token": token, "username": "merry", "password": "meriadoc-pw-1",
	})
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected revoked signup 404, got %d", resp.StatusCode)
	}
}

// TestInvitationSignupValidation covers rejected inputs and the duplicate-username
// case, asserting that a failed signup leaves the invitation redeemable.
func TestInvitationSignupValidation(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)

	_, token, _ := adminCreateInvitation(t, ts, adminC)

	// Bad username.
	resp, _ := doJSON(t, newClient(t), "POST", ts.URL+"/api/auth/signup", map[string]string{
		"token": token, "username": "x", "password": "long-enough-pw",
	})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for bad username, got %d", resp.StatusCode)
	}
	// Short password.
	resp, _ = doJSON(t, newClient(t), "POST", ts.URL+"/api/auth/signup", map[string]string{
		"token": token, "username": "pippin", "password": "short",
	})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for short password, got %d", resp.StatusCode)
	}
	// Duplicate username (admin already exists) -> 409, invitation stays valid.
	resp, _ = doJSON(t, newClient(t), "POST", ts.URL+"/api/auth/signup", map[string]string{
		"token": token, "username": "admin", "password": "long-enough-pw",
	})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 for taken username, got %d", resp.StatusCode)
	}
	// Invitation must still be redeemable after the failures.
	resp, _ = doJSON(t, newClient(t), "GET", ts.URL+"/api/auth/invitation/"+token, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("invitation should survive failed signups, got %d", resp.StatusCode)
	}
	resp, body := doJSON(t, newClient(t), "POST", ts.URL+"/api/auth/signup", map[string]string{
		"token": token, "username": "pippin", "password": "peregrin-pw-1",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup after failures: %d %s", resp.StatusCode, body)
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

func TestGetMessage(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, adminUser := seedAdmin(t, ts, st)

	// Create a public channel and post a message.
	_, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	var ch store.Channel
	json.Unmarshal(body, &ch)
	_, body = doJSON(t, adminC, "POST", ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages", map[string]string{
		"content": "hello embed",
	})
	var msg store.Message
	json.Unmarshal(body, &msg)

	// Fetching by ID returns the message.
	resp, body := doJSON(t, adminC, "GET", ts.URL+"/api/messages/"+itoa(msg.ID), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get message: %d %s", resp.StatusCode, body)
	}
	var got store.Message
	json.Unmarshal(body, &got)
	if got.ID != msg.ID || got.Content != "hello embed" {
		t.Fatalf("unexpected message: %+v", got)
	}

	// Non-existent ID returns 404.
	resp, _ = doJSON(t, adminC, "GET", ts.URL+"/api/messages/999999", nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for missing message, got %d", resp.StatusCode)
	}

	// Member cannot fetch a message from a private channel they're not in.
	ctx := context.Background()
	privCh, _ := st.CreateChannel(ctx, "secret", "", true, adminUser.ID)
	privMsg, _ := st.CreateMessage(ctx, privCh.ID, adminUser.ID, "private msg", nil)
	memberC, _ := seedMember(t, ts, st, "bob", "Bob", store.RoleMember)
	resp, _ = doJSON(t, memberC, "GET", ts.URL+"/api/messages/"+itoa(privMsg.ID), nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for private channel message, got %d", resp.StatusCode)
	}
}

func TestMessageReply(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)

	// Two channels: the reply target lives in the first.
	_, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	var ch store.Channel
	json.Unmarshal(body, &ch)
	_, body = doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "other"})
	var other store.Channel
	json.Unmarshal(body, &other)

	// Parent message.
	_, body = doJSON(t, adminC, "POST", ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages", map[string]any{
		"content": "the original",
	})
	var parent store.Message
	json.Unmarshal(body, &parent)

	// A valid reply echoes reply_to_id back.
	resp, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages", map[string]any{
		"content": "the reply", "reply_to_id": parent.ID,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("post reply: %d %s", resp.StatusCode, body)
	}
	var reply store.Message
	json.Unmarshal(body, &reply)
	if reply.ReplyToID == nil || *reply.ReplyToID != parent.ID {
		t.Fatalf("reply_to_id not round-tripped: %s", body)
	}

	// A reply to a non-existent message is rejected.
	resp, _ = doJSON(t, adminC, "POST", ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages", map[string]any{
		"content": "dangling", "reply_to_id": 999999,
	})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 replying to missing message, got %d", resp.StatusCode)
	}

	// A reply pointing at a message in a different channel is rejected.
	resp, _ = doJSON(t, adminC, "POST", ts.URL+"/api/channels/"+itoa(other.ID)+"/messages", map[string]any{
		"content": "cross-channel", "reply_to_id": parent.ID,
	})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 replying across channels, got %d", resp.StatusCode)
	}

	// A reply to a soft-deleted message is rejected.
	doJSON(t, adminC, "DELETE", ts.URL+"/api/messages/"+itoa(parent.ID), nil)
	resp, _ = doJSON(t, adminC, "POST", ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages", map[string]any{
		"content": "to a ghost", "reply_to_id": parent.ID,
	})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 replying to a deleted message, got %d", resp.StatusCode)
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

// seedMember creates an active user with the given role and returns a
// logged-in client plus the user record.
func seedMember(t *testing.T, ts *httptest.Server, st *store.Store, username, display string, role store.Role) (*http.Client, store.User) {
	t.Helper()
	ctx := context.Background()
	u, err := st.CreateUser(ctx, username, display, role)
	if err != nil {
		t.Fatalf("create %s: %v", username, err)
	}
	pw := username + "-strong-pw"
	hash, _ := auth.HashPassword(pw)
	if err := st.SetPassword(ctx, u.ID, hash); err != nil {
		t.Fatalf("set password %s: %v", username, err)
	}
	c := newClient(t)
	resp, body := doJSON(t, c, "POST", ts.URL+"/api/auth/login", map[string]string{
		"username": username, "password": pw,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login %s: %d %s", username, resp.StatusCode, body)
	}
	return c, u
}

func TestDMCreateFindAndScoping(t *testing.T) {
	ts, st, _ := newTestServer(t)
	seedAdmin(t, ts, st) // first admin so role guards behave

	aliceC, alice := seedMember(t, ts, st, "alice", "Alice", store.RoleMember)
	bobC, bob := seedMember(t, ts, st, "bob", "Bob", store.RoleMember)
	modC, _ := seedMember(t, ts, st, "molly", "Molly", store.RoleModerator)

	// Alice opens a DM with Bob.
	resp, body := doJSON(t, aliceC, "POST", ts.URL+"/api/dms", map[string]int64{"user_id": bob.ID})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("open DM: %d %s", resp.StatusCode, body)
	}
	var dm store.Channel
	json.Unmarshal(body, &dm)
	if !dm.IsDM || !dm.IsPrivate {
		t.Fatalf("DM channel should be private+is_dm, got %+v", dm)
	}

	// Create-or-find: opening again (from either side) returns the same channel.
	resp, body = doJSON(t, bobC, "POST", ts.URL+"/api/dms", map[string]int64{"user_id": alice.ID})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("re-open DM: %d %s", resp.StatusCode, body)
	}
	var dm2 store.Channel
	json.Unmarshal(body, &dm2)
	if dm2.ID != dm.ID {
		t.Fatalf("create-or-find returned a different channel: %d vs %d", dm2.ID, dm.ID)
	}

	// You cannot DM yourself.
	resp, _ = doJSON(t, aliceC, "POST", ts.URL+"/api/dms", map[string]int64{"user_id": alice.ID})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("self-DM should be 400, got %d", resp.StatusCode)
	}

	// Both participants see the DM in their channel list.
	for _, c := range []*http.Client{aliceC, bobC} {
		resp, body = doJSON(t, c, "GET", ts.URL+"/api/channels", nil)
		var chans []store.Channel
		json.Unmarshal(body, &chans)
		found := false
		for _, ch := range chans {
			if ch.ID == dm.ID {
				found = true
			}
		}
		if !found {
			t.Fatalf("participant should see the DM in channel list: %s", body)
		}
	}

	// A moderator who is not a participant must NOT see or access the DM,
	// despite the moderator+ bypass that applies to regular private channels.
	resp, body = doJSON(t, modC, "GET", ts.URL+"/api/channels", nil)
	var modChans []store.Channel
	json.Unmarshal(body, &modChans)
	for _, ch := range modChans {
		if ch.ID == dm.ID {
			t.Fatalf("moderator must not see another pair's DM")
		}
	}
	resp, _ = doJSON(t, modC, "GET", ts.URL+"/api/channels/"+itoa(dm.ID)+"/messages", nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("moderator must be denied DM messages, got %d", resp.StatusCode)
	}

	// Alice posts; Bob can read it.
	resp, body = doJSON(t, aliceC, "POST", ts.URL+"/api/channels/"+itoa(dm.ID)+"/messages", map[string]string{
		"content": "hey bob",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("alice post to DM: %d %s", resp.StatusCode, body)
	}
	resp, body = doJSON(t, bobC, "GET", ts.URL+"/api/channels/"+itoa(dm.ID)+"/messages", nil)
	var msgs []store.Message
	json.Unmarshal(body, &msgs)
	if len(msgs) != 1 || msgs[0].Content != "hey bob" {
		t.Fatalf("bob should read alice's DM message, got %s", body)
	}
}

// TestDMOpenStateServerAuthoritative covers the server-side "open DM" state: a
// closed DM drops out of that user's channel list (but not the other party's),
// the channel and its history survive, and a new message reopens it.
func TestDMOpenStateServerAuthoritative(t *testing.T) {
	ts, st, _ := newTestServer(t)
	seedAdmin(t, ts, st)
	aliceC, alice := seedMember(t, ts, st, "alice", "Alice", store.RoleMember)
	bobC, bob := seedMember(t, ts, st, "bob", "Bob", store.RoleMember)

	// listHasDM reports whether the given client's channel list includes id.
	listHasDM := func(c *http.Client, id int64) bool {
		_, body := doJSON(t, c, "GET", ts.URL+"/api/channels", nil)
		var chans []store.Channel
		json.Unmarshal(body, &chans)
		for _, ch := range chans {
			if ch.ID == id {
				return true
			}
		}
		return false
	}

	// Alice opens a DM with Bob; it's open for both.
	_, body := doJSON(t, aliceC, "POST", ts.URL+"/api/dms", map[string]int64{"user_id": bob.ID})
	var dm store.Channel
	json.Unmarshal(body, &dm)
	if !listHasDM(aliceC, dm.ID) || !listHasDM(bobC, dm.ID) {
		t.Fatalf("a freshly opened DM should be visible to both participants")
	}

	// Bob closes it: gone from Bob's list, still in Alice's (per-user state).
	resp, body := doJSON(t, bobC, "DELETE", ts.URL+"/api/dms/"+itoa(dm.ID), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("close DM: %d %s", resp.StatusCode, body)
	}
	if listHasDM(bobC, dm.ID) {
		t.Fatalf("a closed DM must not appear in the closer's channel list")
	}
	if !listHasDM(aliceC, dm.ID) {
		t.Fatalf("closing is per-user: the other participant's list is unaffected")
	}

	// The channel and its history are untouched — Bob can still read it directly.
	resp, _ = doJSON(t, bobC, "GET", ts.URL+"/api/channels/"+itoa(dm.ID)+"/messages", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("closing a DM must not revoke access, got %d", resp.StatusCode)
	}

	// A new message from Alice reopens the DM for Bob.
	resp, body = doJSON(t, aliceC, "POST", ts.URL+"/api/channels/"+itoa(dm.ID)+"/messages",
		map[string]string{"content": "you there?"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("alice post to DM: %d %s", resp.StatusCode, body)
	}
	if !listHasDM(bobC, dm.ID) {
		t.Fatalf("a new message must reopen the DM for the recipient")
	}

	// Only a participant may close a DM: a non-participant (the admin) is denied.
	adminC, _ := seedMember(t, ts, st, "carol", "Carol", store.RoleModerator)
	resp, _ = doJSON(t, adminC, "DELETE", ts.URL+"/api/dms/"+itoa(dm.ID), nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("non-participant closing a DM should be 403, got %d", resp.StatusCode)
	}

	// Closing only applies to DMs: a public channel id is a 404.
	_, body = doJSON(t, aliceC, "GET", ts.URL+"/api/channels", nil)
	var chans []store.Channel
	json.Unmarshal(body, &chans)
	var pub int64
	for _, ch := range chans {
		if !ch.IsDM {
			pub = ch.ID
			break
		}
	}
	if pub != 0 {
		resp, _ = doJSON(t, aliceC, "DELETE", ts.URL+"/api/dms/"+itoa(pub), nil)
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("closing a non-DM channel should be 404, got %d", resp.StatusCode)
		}
	}
	_ = alice
}

func TestPrivateChannelInvite(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)
	daveC, dave := seedMember(t, ts, st, "dave", "Dave", store.RoleMember)

	// Admin creates a private channel (and is auto-joined as creator).
	resp, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{
		"name": "secret-plans", "is_private": true,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create private channel: %d %s", resp.StatusCode, body)
	}
	var ch store.Channel
	json.Unmarshal(body, &ch)

	// Dave can't see it yet, and can't read its messages.
	resp, _ = doJSON(t, daveC, "GET", ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages", nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("non-member should be denied, got %d", resp.StatusCode)
	}

	// A non-member member (Dave) cannot invite either.
	resp, _ = doJSON(t, daveC, "POST", ts.URL+"/api/channels/"+itoa(ch.ID)+"/members", map[string]int64{"user_id": dave.ID})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("non-member invite should be 403, got %d", resp.StatusCode)
	}

	// Admin (a member) invites Dave.
	resp, body = doJSON(t, adminC, "POST", ts.URL+"/api/channels/"+itoa(ch.ID)+"/members", map[string]int64{"user_id": dave.ID})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("admin invite: %d %s", resp.StatusCode, body)
	}

	// Now Dave sees it in his channel list and can read it.
	resp, body = doJSON(t, daveC, "GET", ts.URL+"/api/channels", nil)
	var chans []store.Channel
	json.Unmarshal(body, &chans)
	found := false
	for _, c := range chans {
		if c.ID == ch.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("invited member should see the private channel: %s", body)
	}
	resp, _ = doJSON(t, daveC, "GET", ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("invited member should read messages, got %d", resp.StatusCode)
	}

	// Member list now includes both admin and Dave.
	resp, body = doJSON(t, adminC, "GET", ts.URL+"/api/channels/"+itoa(ch.ID)+"/members", nil)
	var members []store.User
	json.Unmarshal(body, &members)
	if len(members) != 2 {
		t.Fatalf("expected 2 members, got %d: %s", len(members), body)
	}

	// A regular member of the channel still cannot invite — only moderators+.
	_, erin := seedMember(t, ts, st, "erin", "Erin", store.RoleMember)
	resp, _ = doJSON(t, daveC, "POST", ts.URL+"/api/channels/"+itoa(ch.ID)+"/members", map[string]int64{"user_id": erin.ID})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("non-moderator member invite should be 403, got %d", resp.StatusCode)
	}

	// You cannot manage membership of a DM.
	resp, body = doJSON(t, adminC, "POST", ts.URL+"/api/dms", map[string]int64{"user_id": dave.ID})
	var dm store.Channel
	json.Unmarshal(body, &dm)
	resp, _ = doJSON(t, adminC, "POST", ts.URL+"/api/channels/"+itoa(dm.ID)+"/members", map[string]int64{"user_id": dave.ID})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("adding a member to a DM should be 403, got %d", resp.StatusCode)
	}
}

func TestInstanceName(t *testing.T) {
	ts, _, _ := newTestServer(t)
	c := newClient(t)
	resp, body := doJSON(t, c, "GET", ts.URL+"/api/instance", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("instance: %d %s", resp.StatusCode, body)
	}
	var inst struct {
		Name           string `json:"name"`
		Version        string `json:"version"`
		MaxImageBytes  int    `json:"max_image_bytes"`
		MaxAvatarBytes int    `json:"max_avatar_bytes"`
	}
	json.Unmarshal(body, &inst)
	if inst.Name != "rivendell-test" {
		t.Fatalf("instance name = %q, want rivendell-test", inst.Name)
	}
	if inst.Version != config.Version {
		t.Fatalf("instance version = %q, want %q", inst.Version, config.Version)
	}
	if inst.MaxImageBytes != 5*1024*1024 {
		t.Fatalf("instance max_image_bytes = %d, want %d", inst.MaxImageBytes, 5*1024*1024)
	}
	if inst.MaxAvatarBytes != 1<<20 {
		t.Fatalf("instance max_avatar_bytes = %d, want %d", inst.MaxAvatarBytes, 1<<20)
	}
}

// TestInstanceNameInHTML checks the instance name is threaded into the served
// index.html (title + social-card meta), so non-JS scrapers get the brand.
func TestInstanceNameInHTML(t *testing.T) {
	ts, _, cfg := newTestServer(t)
	// newTestServer points WebDir at a temp dir; drop a minimal index.html there.
	if err := os.WriteFile(cfg.WebDir+"/index.html",
		[]byte(`<title>__RIVENDELL_INSTANCE__</title><meta property="og:title" content="__RIVENDELL_INSTANCE__">`), 0o644); err != nil {
		t.Fatal(err)
	}
	c := newClient(t)
	resp, body := doJSON(t, c, "GET", ts.URL+"/", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("index: %d", resp.StatusCode)
	}
	s := string(body)
	if strings.Contains(s, "__RIVENDELL_INSTANCE__") {
		t.Fatalf("placeholder not substituted: %s", s)
	}
	if !strings.Contains(s, "<title>rivendell-test</title>") || !strings.Contains(s, `content="rivendell-test"`) {
		t.Fatalf("instance name not threaded into html: %s", s)
	}
}

// TestStatusDurableAcrossReconnect guards the regression where a websocket
// connect/disconnect overwrote the user's chosen status. A connect followed by a
// disconnect must leave the stored status untouched.
func TestStatusDurableAcrossReconnect(t *testing.T) {
	ts, st, cfg := newTestServer(t)
	_ = ts
	srv := New(cfg, st)
	ctx := context.Background()

	u, err := st.CreateUser(ctx, "frodo", "Frodo", store.RoleMember)
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	if u.Status != "online" {
		t.Fatalf("new user default status = %q, want online", u.Status)
	}

	if err := st.SetStatus(ctx, u.ID, "away"); err != nil {
		t.Fatalf("set status: %v", err)
	}
	// Simulate a websocket connect then disconnect.
	srv.onPresenceChange(u.ID, true)
	srv.onPresenceChange(u.ID, false)

	got, err := st.GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	if got.Status != "away" {
		t.Fatalf("status was clobbered by presence change: got %q, want away", got.Status)
	}
}

// TestDMCallEndsForBothParties guards the DM phone-call semantics: in a 2-party
// DM, either party hanging up (voice.leave → endDMVoiceCall) or dropping
// (disconnect → cleanupVoiceForUser) ends the call for both, so nobody is left
// stranded alone in a one-person "call".
func TestDMCallEndsForBothParties(t *testing.T) {
	ts, st, cfg := newTestServer(t)
	_ = ts
	srv := New(cfg, st)
	ctx := context.Background()

	a, err := st.CreateUser(ctx, "aragorn", "Aragorn", store.RoleMember)
	if err != nil {
		t.Fatalf("create a: %v", err)
	}
	b, err := st.CreateUser(ctx, "boromir", "Boromir", store.RoleMember)
	if err != nil {
		t.Fatalf("create b: %v", err)
	}
	dm, _, err := st.GetOrCreateDM(ctx, a.ID, b.ID)
	if err != nil {
		t.Fatalf("create dm: %v", err)
	}
	ch, err := st.GetChannel(ctx, dm.ID)
	if err != nil {
		t.Fatalf("get dm channel: %v", err)
	}

	// One party hangs up — the whole DM call ends (B isn't left alone).
	srv.Hub().VoiceJoin(dm.ID, a.ID)
	srv.Hub().VoiceJoin(dm.ID, b.ID)
	srv.endDMVoiceCall(ch, a.ID)
	if p := srv.Hub().VoiceParticipants(dm.ID); len(p) != 0 {
		t.Fatalf("DM call not ended when one party hung up: %v", p)
	}

	// Disconnect path: rejoin both, then B drops — same outcome.
	srv.Hub().VoiceJoin(dm.ID, a.ID)
	srv.Hub().VoiceJoin(dm.ID, b.ID)
	srv.cleanupVoiceForUser(ctx, b.ID)
	if p := srv.Hub().VoiceParticipants(dm.ID); len(p) != 0 {
		t.Fatalf("DM call not ended when a party dropped: %v", p)
	}
}

// TestVoiceChannelLeaveKeepsOthers is the counterpart: a regular (non-DM) voice
// channel keeps its voice-channel semantics — one participant dropping must not
// evict the rest. Only DMs get phone-call "ends for both" behavior.
func TestVoiceChannelLeaveKeepsOthers(t *testing.T) {
	ts, st, cfg := newTestServer(t)
	_ = ts
	srv := New(cfg, st)
	ctx := context.Background()

	a, err := st.CreateUser(ctx, "gimli", "Gimli", store.RoleMember)
	if err != nil {
		t.Fatalf("create a: %v", err)
	}
	b, err := st.CreateUser(ctx, "legolas", "Legolas", store.RoleMember)
	if err != nil {
		t.Fatalf("create b: %v", err)
	}
	ch, err := st.CreateChannel(ctx, "war-room", "", false, a.ID)
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}

	srv.Hub().VoiceJoin(ch.ID, a.ID)
	srv.Hub().VoiceJoin(ch.ID, b.ID)
	srv.cleanupVoiceForUser(ctx, a.ID)

	p := srv.Hub().VoiceParticipants(ch.ID)
	if len(p) != 1 || p[0].UserID != b.ID {
		t.Fatalf("non-DM voice channel should keep the remaining participant; got %v", p)
	}
}

// TestRTCCredentials guards the two things coturn is unforgiving about: the MAC
// must be HMAC-SHA1 (coturn computes SHA1; SHA256 → every credential rejected),
// and RIVENDELL_TURN_URL is a comma-separated list surfaced as a JSON array so a
// turn: and a turns: endpoint can share the one credential.
func TestRTCCredentials(t *testing.T) {
	_, st, cfg := newTestServer(t)
	cfg.StunURL = "stun:stun.example.com:3478"
	cfg.TurnURL = "turn:turn.example.com:3478, turns:turn.example.com:5349?transport=tcp"
	cfg.TurnSecret = "shared-secret"
	srv := New(cfg, st)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	adminC, _ := seedAdmin(t, ts, st)
	resp, body := doJSON(t, adminC, "GET", ts.URL+"/api/rtc/credentials", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("credentials: %d %s", resp.StatusCode, body)
	}
	var got struct {
		Stun       string   `json:"stun"`
		Turn       []string `json:"turn"`
		Username   string   `json:"username"`
		Credential string   `json:"credential"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v (%s)", err, body)
	}

	if got.Stun != cfg.StunURL {
		t.Fatalf("stun = %q, want %q", got.Stun, cfg.StunURL)
	}
	// Comma-split, trimmed, both endpoints present and in order.
	wantTurn := []string{"turn:turn.example.com:3478", "turns:turn.example.com:5349?transport=tcp"}
	if !reflect.DeepEqual(got.Turn, wantTurn) {
		t.Fatalf("turn = %#v, want %#v", got.Turn, wantTurn)
	}

	// The credential must equal base64(HMAC-SHA1(secret, username)).
	mac := hmac.New(sha1.New, []byte(cfg.TurnSecret))
	mac.Write([]byte(got.Username))
	wantCred := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if got.Credential != wantCred {
		t.Fatalf("credential is not HMAC-SHA1 of the username — SHA256 regression?")
	}
	// Independent guard: a SHA1 digest is 20 bytes; SHA256 would be 32.
	raw, err := base64.StdEncoding.DecodeString(got.Credential)
	if err != nil {
		t.Fatalf("credential not valid base64: %v", err)
	}
	if len(raw) != sha1.Size {
		t.Fatalf("credential digest = %d bytes, want %d (SHA1)", len(raw), sha1.Size)
	}
}

func TestPinMessages(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)
	memberC, _ := seedMember(t, ts, st, "sam", "Sam", store.RoleMember)

	resp, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create channel: %d %s", resp.StatusCode, body)
	}
	var ch store.Channel
	json.Unmarshal(body, &ch)

	resp, body = doJSON(t, adminC, "POST", ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages", map[string]string{"content": "read me"})
	var msg store.Message
	json.Unmarshal(body, &msg)

	// A plain member cannot pin (mod+ only).
	resp, _ = doJSON(t, memberC, "PUT", ts.URL+"/api/messages/"+itoa(msg.ID)+"/pin", nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member pin should be 403, got %d", resp.StatusCode)
	}

	// Admin pins it; the returned message carries pinned_at.
	resp, body = doJSON(t, adminC, "PUT", ts.URL+"/api/messages/"+itoa(msg.ID)+"/pin", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("admin pin: %d %s", resp.StatusCode, body)
	}
	var pinned store.Message
	json.Unmarshal(body, &pinned)
	if pinned.PinnedAt == nil {
		t.Fatalf("pinned message should have pinned_at set: %s", body)
	}

	// The pins list (readable by any member) now contains it.
	resp, body = doJSON(t, memberC, "GET", ts.URL+"/api/channels/"+itoa(ch.ID)+"/pins", nil)
	var pins []store.Message
	json.Unmarshal(body, &pins)
	if len(pins) != 1 || pins[0].ID != msg.ID {
		t.Fatalf("expected 1 pinned message, got %s", body)
	}

	// Unpin and confirm the list empties.
	resp, _ = doJSON(t, adminC, "DELETE", ts.URL+"/api/messages/"+itoa(msg.ID)+"/pin", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unpin: %d", resp.StatusCode)
	}
	resp, body = doJSON(t, adminC, "GET", ts.URL+"/api/channels/"+itoa(ch.ID)+"/pins", nil)
	json.Unmarshal(body, &pins)
	if len(pins) != 0 {
		t.Fatalf("pins should be empty after unpin, got %s", body)
	}
}

// TestMessagePagination exercises the scrollback data path: newest-first paging
// via limit, oldest-first ordering within a page, and the `before` cursor
// stepping back through history to a short final page.
func TestMessagePagination(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)

	resp, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create channel: %d %s", resp.StatusCode, body)
	}
	var ch store.Channel
	json.Unmarshal(body, &ch)

	ids := []int64{}
	for i := 1; i <= 5; i++ {
		_, b := doJSON(t, adminC, "POST", ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages",
			map[string]string{"content": "m" + itoa(int64(i))})
		var m store.Message
		json.Unmarshal(b, &m)
		ids = append(ids, m.ID)
	}

	get := func(q string) []store.Message {
		_, b := doJSON(t, adminC, "GET", ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages"+q, nil)
		var out []store.Message
		json.Unmarshal(b, &out)
		return out
	}

	// Newest page of 2, oldest-first within the page: [ids[3], ids[4]].
	p1 := get("?limit=2")
	if len(p1) != 2 || p1[0].ID != ids[3] || p1[1].ID != ids[4] {
		t.Fatalf("newest page wrong: %+v (ids=%v)", p1, ids)
	}
	// One page older: [ids[1], ids[2]].
	p2 := get("?limit=2&before=" + itoa(p1[0].ID))
	if len(p2) != 2 || p2[0].ID != ids[1] || p2[1].ID != ids[2] {
		t.Fatalf("older page wrong: %+v", p2)
	}
	// Final (short) page: just [ids[0]] — the signal the client uses to stop.
	p3 := get("?limit=2&before=" + itoa(p2[0].ID))
	if len(p3) != 1 || p3[0].ID != ids[0] {
		t.Fatalf("final page wrong: %+v", p3)
	}
}

func TestArchivedChannelRestoreAndPurge(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)
	modC, _ := seedMember(t, ts, st, "molly", "Molly", store.RoleModerator)

	resp, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "temp"})
	var ch store.Channel
	json.Unmarshal(body, &ch)

	// Archive it, then confirm the name is still reserved (the bug being fixed).
	doJSON(t, adminC, "DELETE", ts.URL+"/api/channels/"+itoa(ch.ID), nil)
	resp, _ = doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "temp"})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("recreating an archived name should 409, got %d", resp.StatusCode)
	}

	// A moderator can't reach the admin restore/purge endpoints.
	resp, _ = doJSON(t, modC, "GET", ts.URL+"/api/admin/channels/archived", nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("moderator should be 403 on admin channels, got %d", resp.StatusCode)
	}

	// It shows up in the archived list, and restore brings it back live.
	resp, body = doJSON(t, adminC, "GET", ts.URL+"/api/admin/channels/archived", nil)
	var arch []store.Channel
	json.Unmarshal(body, &arch)
	if len(arch) != 1 || arch[0].ID != ch.ID || arch[0].ArchivedAt == nil {
		t.Fatalf("archived list wrong: %s", body)
	}
	resp, _ = doJSON(t, adminC, "POST", ts.URL+"/api/admin/channels/"+itoa(ch.ID)+"/restore", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("restore: %d", resp.StatusCode)
	}
	resp, body = doJSON(t, adminC, "GET", ts.URL+"/api/channels", nil)
	var live []store.Channel
	json.Unmarshal(body, &live)
	found := false
	for _, c := range live {
		if c.ID == ch.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("restored channel should be live again: %s", body)
	}

	// Purging a *live* channel is refused.
	resp, _ = doJSON(t, adminC, "DELETE", ts.URL+"/api/admin/channels/"+itoa(ch.ID), nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("purging a live channel should 404, got %d", resp.StatusCode)
	}

	// Archive then purge, and confirm the name is finally reusable.
	doJSON(t, adminC, "DELETE", ts.URL+"/api/channels/"+itoa(ch.ID), nil)
	resp, _ = doJSON(t, adminC, "DELETE", ts.URL+"/api/admin/channels/"+itoa(ch.ID), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("purge: %d", resp.StatusCode)
	}
	resp, _ = doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "temp"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("name should be reusable after purge, got %d", resp.StatusCode)
	}
}

// TestMessageEditDeleteAuthorization pins the authz boundary: you may edit/delete
// only your own messages, except moderators+ may delete anyone's.
func TestMessageEditDeleteAuthorization(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st) // admin is moderator+
	aliceC, _ := seedMember(t, ts, st, "alice", "Alice", store.RoleMember)
	bobC, _ := seedMember(t, ts, st, "bob", "Bob", store.RoleMember)

	_, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	var ch store.Channel
	json.Unmarshal(body, &ch)
	mpath := ts.URL + "/api/channels/" + itoa(ch.ID) + "/messages"

	resp, body := doJSON(t, aliceC, "POST", mpath, map[string]string{"content": "hi from alice"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("alice post: %d %s", resp.StatusCode, body)
	}
	var msg store.Message
	json.Unmarshal(body, &msg)
	mid := itoa(msg.ID)

	// A non-author member can neither edit nor delete someone else's message.
	resp, _ = doJSON(t, bobC, "PATCH", ts.URL+"/api/messages/"+mid, map[string]string{"content": "hacked"})
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("non-author edit should 404, got %d", resp.StatusCode)
	}
	resp, _ = doJSON(t, bobC, "DELETE", ts.URL+"/api/messages/"+mid, nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("non-author delete should 404, got %d", resp.StatusCode)
	}

	// The author can edit their own.
	resp, body = doJSON(t, aliceC, "PATCH", ts.URL+"/api/messages/"+mid, map[string]string{"content": "edited"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("author edit: %d %s", resp.StatusCode, body)
	}
	var edited store.Message
	json.Unmarshal(body, &edited)
	if edited.Content != "edited" || edited.EditedAt == nil {
		t.Fatalf("edit not applied: %s", body)
	}

	// A moderator+ may delete another user's message (mod override).
	resp, _ = doJSON(t, adminC, "DELETE", ts.URL+"/api/messages/"+mid, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("mod-override delete: %d", resp.StatusCode)
	}
	resp, body = doJSON(t, aliceC, "GET", mpath, nil)
	var msgs []store.Message
	json.Unmarshal(body, &msgs)
	if len(msgs) != 1 || msgs[0].DeletedAt == nil || msgs[0].Content != "" {
		t.Fatalf("message should be soft-deleted: %s", body)
	}
}

func TestSetStatusValidation(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)

	resp, _ := doJSON(t, adminC, "PUT", ts.URL+"/api/me/status", map[string]string{"status": "bogus"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid status should 400, got %d", resp.StatusCode)
	}
	resp, _ = doJSON(t, adminC, "PUT", ts.URL+"/api/me/status", map[string]string{"status": "dnd"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("valid status: %d", resp.StatusCode)
	}
	_, body := doJSON(t, adminC, "GET", ts.URL+"/api/me", nil)
	var me store.User
	json.Unmarshal(body, &me)
	if me.Status != "dnd" {
		t.Fatalf("status not persisted: %s", body)
	}
}

func TestUpdateProfileValidation(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)

	resp, _ := doJSON(t, adminC, "PATCH", ts.URL+"/api/me", map[string]string{"display_name": "   "})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("blank display name should 400, got %d", resp.StatusCode)
	}
	resp, body := doJSON(t, adminC, "PATCH", ts.URL+"/api/me", map[string]string{"display_name": "Big Admin", "status_text": "around"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("profile update: %d %s", resp.StatusCode, body)
	}
	var me store.User
	json.Unmarshal(body, &me)
	if me.DisplayName != "Big Admin" || me.StatusText != "around" {
		t.Fatalf("profile not updated: %s", body)
	}
	if me.Theme != "default" {
		t.Fatalf("fresh user should default to the 'default' theme, got %q", me.Theme)
	}

	// A valid theme persists and round-trips on the returned user.
	resp, body = doJSON(t, adminC, "PATCH", ts.URL+"/api/me", map[string]string{"theme": "vermillion"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("theme update: %d %s", resp.StatusCode, body)
	}
	json.Unmarshal(body, &me)
	if me.Theme != "vermillion" {
		t.Fatalf("theme not updated: %s", body)
	}
	// And it sticks across a reload (GET /api/me).
	resp, body = doJSON(t, adminC, "GET", ts.URL+"/api/me", nil)
	json.Unmarshal(body, &me)
	if me.Theme != "vermillion" {
		t.Fatalf("theme not durable: %s", body)
	}

	// An unknown theme is rejected (and leaves the persisted value untouched).
	resp, _ = doJSON(t, adminC, "PATCH", ts.URL+"/api/me", map[string]string{"theme": "bogus"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid theme should 400, got %d", resp.StatusCode)
	}

	// Pronouns and bio round-trip and persist across a reload.
	resp, body = doJSON(t, adminC, "PATCH", ts.URL+"/api/me",
		map[string]string{"pronouns": "they/them", "bio": "I like notes boxes."})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("profile update: %d %s", resp.StatusCode, body)
	}
	json.Unmarshal(body, &me)
	if me.Pronouns != "they/them" || me.Bio != "I like notes boxes." {
		t.Fatalf("pronouns/bio not updated: %s", body)
	}
	resp, body = doJSON(t, adminC, "GET", ts.URL+"/api/me", nil)
	json.Unmarshal(body, &me)
	if me.Pronouns != "they/them" || me.Bio != "I like notes boxes." {
		t.Fatalf("pronouns/bio not durable: %s", body)
	}

	// Over-long pronouns/bio are rejected (and leave the persisted values alone).
	resp, _ = doJSON(t, adminC, "PATCH", ts.URL+"/api/me",
		map[string]string{"pronouns": strings.Repeat("x", 33)})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("over-long pronouns should 400, got %d", resp.StatusCode)
	}
	resp, _ = doJSON(t, adminC, "PATCH", ts.URL+"/api/me",
		map[string]string{"bio": strings.Repeat("x", 1001)})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("over-long bio should 400, got %d", resp.StatusCode)
	}
}

// unreadResp mirrors the /api/unread payload.
type unreadResp struct {
	Channels      []store.ChannelUnread `json:"channels"`
	TotalUnread   int                   `json:"total_unread"`
	TotalMentions int                   `json:"total_mentions"`
	Muted         []int64               `json:"muted"`
}

func getUnread(t *testing.T, c *http.Client, ts *httptest.Server) unreadResp {
	t.Helper()
	resp, body := doJSON(t, c, "GET", ts.URL+"/api/unread", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unread: %d %s", resp.StatusCode, body)
	}
	var u unreadResp
	if err := json.Unmarshal(body, &u); err != nil {
		t.Fatalf("unread unmarshal: %v (%s)", err, body)
	}
	return u
}

func chUnread(u unreadResp, channelID int64) store.ChannelUnread {
	for _, c := range u.Channels {
		if c.ChannelID == channelID {
			return c
		}
	}
	return store.ChannelUnread{ChannelID: channelID}
}

func postMessage(t *testing.T, c *http.Client, ts *httptest.Server, channelID int64, content string) store.Message {
	t.Helper()
	resp, body := doJSON(t, c, "POST", ts.URL+"/api/channels/"+itoa(channelID)+"/messages",
		map[string]string{"content": content})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("post message: %d %s", resp.StatusCode, body)
	}
	var m store.Message
	json.Unmarshal(body, &m)
	return m
}

// TestUnreadEmptyArray pins the list-endpoint contract: a fresh user's unread
// payload must carry an empty array, never JSON null (the client iterates it).
func TestUnreadEmptyArray(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)
	resp, body := doJSON(t, adminC, "GET", ts.URL+"/api/unread", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unread: %d %s", resp.StatusCode, body)
	}
	if !bytes.Contains(body, []byte(`"channels":[]`)) {
		t.Fatalf("empty unread must carry channels:[], got %s", body)
	}
}

// TestUnreadCountsAndMarkRead drives the durable-count path end to end: unread
// accrues for messages you didn't send, @-mentions and DMs additionally count as
// pings, marking a channel read clears it, and the read cursor is monotonic.
func TestUnreadCountsAndMarkRead(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)
	aliceC, _ := seedMember(t, ts, st, "alice", "Alice", store.RoleMember)
	bobC, bob := seedMember(t, ts, st, "bob", "Bob", store.RoleMember)

	// Public channel.
	_, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	var general store.Channel
	json.Unmarshal(body, &general)

	// Alice posts a plain line and an @bob mention; bob (not the author) is behind.
	postMessage(t, aliceC, ts, general.ID, "hello everyone")
	mentionMsg := postMessage(t, aliceC, ts, general.ID, "hey @bob look at this")

	u := getUnread(t, bobC, ts)
	if cu := chUnread(u, general.ID); cu.Unread != 2 || cu.Mentions != 1 {
		t.Fatalf("bob general unread: got %+v, want unread=2 mentions=1", cu)
	}

	// Alice's own view: she authored both, so nothing unread for her.
	if cu := chUnread(getUnread(t, aliceC, ts), general.ID); cu.Unread != 0 {
		t.Fatalf("author should have 0 unread, got %+v", cu)
	}

	// A DM from alice to bob: every DM message is a ping.
	_, body = doJSON(t, aliceC, "POST", ts.URL+"/api/dms", map[string]int64{"user_id": bob.ID})
	var dm store.Channel
	json.Unmarshal(body, &dm)
	postMessage(t, aliceC, ts, dm.ID, "yo bob")

	u = getUnread(t, bobC, ts)
	if cu := chUnread(u, dm.ID); cu.Unread != 1 || cu.Mentions != 1 {
		t.Fatalf("bob dm unread: got %+v, want unread=1 mentions=1", cu)
	}
	// Totals: 2 unread in general + 1 in dm = 3; pings = 1 mention + 1 dm = 2.
	if u.TotalUnread != 3 || u.TotalMentions != 2 {
		t.Fatalf("totals: got unread=%d mentions=%d, want 3/2", u.TotalUnread, u.TotalMentions)
	}

	// Bob marks general read up to the mention message.
	resp, mrBody := doJSON(t, bobC, "POST", ts.URL+"/api/channels/"+itoa(general.ID)+"/read",
		map[string]int64{"message_id": mentionMsg.ID})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("mark read: %d %s", resp.StatusCode, mrBody)
	}
	u = getUnread(t, bobC, ts)
	if cu := chUnread(u, general.ID); cu.Unread != 0 || cu.Mentions != 0 {
		t.Fatalf("general should be cleared, got %+v", cu)
	}
	if u.TotalMentions != 1 { // only the DM ping remains
		t.Fatalf("after clearing general, total mentions = %d, want 1", u.TotalMentions)
	}

	// Monotonic cursor: marking read with an older id must not reopen unread.
	doJSON(t, bobC, "POST", ts.URL+"/api/channels/"+itoa(general.ID)+"/read",
		map[string]int64{"message_id": 1})
	if cu := chUnread(getUnread(t, bobC, ts), general.ID); cu.Unread != 0 {
		t.Fatalf("cursor moved backward: general unread = %d, want 0", cu.Unread)
	}
}

// TestMentionClearedOnDeleteAndEdit confirms pings track the message: deleting a
// mention clears its ping, and editing recomputes (adding a mention pings).
func TestMentionClearedOnDeleteAndEdit(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)
	aliceC, _ := seedMember(t, ts, st, "alice", "Alice", store.RoleMember)
	bobC, _ := seedMember(t, ts, st, "bob", "Bob", store.RoleMember)

	_, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	var general store.Channel
	json.Unmarshal(body, &general)

	mention := postMessage(t, aliceC, ts, general.ID, "ping @bob")
	if chUnread(getUnread(t, bobC, ts), general.ID).Mentions != 1 {
		t.Fatalf("expected 1 mention before delete")
	}
	// Alice deletes it; the ping goes away.
	doJSON(t, aliceC, "DELETE", ts.URL+"/api/messages/"+itoa(mention.ID), nil)
	if chUnread(getUnread(t, bobC, ts), general.ID).Mentions != 0 {
		t.Fatalf("mention should clear after delete")
	}

	// A plain message edited to add @bob becomes a ping.
	plain := postMessage(t, aliceC, ts, general.ID, "nothing here")
	if chUnread(getUnread(t, bobC, ts), general.ID).Mentions != 0 {
		t.Fatalf("plain message should not mention bob")
	}
	resp, eb := doJSON(t, aliceC, "PATCH", ts.URL+"/api/messages/"+itoa(plain.ID),
		map[string]string{"content": "actually @bob"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("edit: %d %s", resp.StatusCode, eb)
	}
	if chUnread(getUnread(t, bobC, ts), general.ID).Mentions != 1 {
		t.Fatalf("edit should have added a mention ping")
	}
}

// TestReplyPingsParentAuthor confirms a reply pings the author of the message it
// replies to, with no explicit @-mention — and that the ping is deduplicated when
// the reply also @-mentions the same person, and never fires for replying to your
// own message.
func TestReplyPingsParentAuthor(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)
	aliceC, _ := seedMember(t, ts, st, "alice", "Alice", store.RoleMember)
	bobC, _ := seedMember(t, ts, st, "bob", "Bob", store.RoleMember)

	_, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	var general store.Channel
	json.Unmarshal(body, &general)

	// Bob posts; Alice replies with no @-mention. Bob is pinged purely by the reply.
	parent := postMessage(t, bobC, ts, general.ID, "anyone around?")
	resp, rb := doJSON(t, aliceC, "POST", ts.URL+"/api/channels/"+itoa(general.ID)+"/messages",
		map[string]any{"content": "yes, here", "reply_to_id": parent.ID})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("post reply: %d %s", resp.StatusCode, rb)
	}
	if cu := chUnread(getUnread(t, bobC, ts), general.ID); cu.Mentions != 1 {
		t.Fatalf("reply should ping the parent author: got %+v, want mentions=1", cu)
	}

	// A reply that also @-mentions the parent author counts once, not twice.
	parent2 := postMessage(t, bobC, ts, general.ID, "still here?")
	doJSON(t, aliceC, "POST", ts.URL+"/api/channels/"+itoa(general.ID)+"/messages",
		map[string]any{"content": "yep @bob", "reply_to_id": parent2.ID})
	if cu := chUnread(getUnread(t, bobC, ts), general.ID); cu.Mentions != 2 {
		t.Fatalf("reply+mention to same user should add one ping: got %+v, want mentions=2", cu)
	}

	// Replying to your own message pings no one.
	own := postMessage(t, aliceC, ts, general.ID, "talking to myself")
	doJSON(t, aliceC, "POST", ts.URL+"/api/channels/"+itoa(general.ID)+"/messages",
		map[string]any{"content": "still me", "reply_to_id": own.ID})
	if cu := chUnread(getUnread(t, aliceC, ts), general.ID); cu.Mentions != 0 {
		t.Fatalf("replying to yourself must not ping: got %+v, want mentions=0", cu)
	}
}

// TestNewUserSeededCaughtUp verifies a user created through the invitation signup
// flow is seeded "caught up" on existing public channels rather than facing the
// backlog (handleSignup seeds public read cursors).
func TestNewUserSeededCaughtUp(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)

	_, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	var general store.Channel
	json.Unmarshal(body, &general)
	postMessage(t, adminC, ts, general.ID, "history one")
	postMessage(t, adminC, ts, general.ID, "history two")

	// Create a fresh user via the invitation signup flow (auto-logged-in).
	_, token, _ := adminCreateInvitation(t, ts, adminC)
	c := newClient(t)
	resp, body := doJSON(t, c, "POST", ts.URL+"/api/auth/signup",
		map[string]string{"token": token, "username": "newbie", "password": "newbie-strong-pw"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup: %d %s", resp.StatusCode, body)
	}

	if cu := chUnread(getUnread(t, c, ts), general.ID); cu.Unread != 0 {
		t.Fatalf("new user should start caught up, got general unread=%d", cu.Unread)
	}

	// A message posted *after* they joined does count as unread.
	postMessage(t, adminC, ts, general.ID, "fresh news")
	if cu := chUnread(getUnread(t, c, ts), general.ID); cu.Unread != 1 {
		t.Fatalf("post-join message should be unread, got %d", cu.Unread)
	}
}

// TestDisabledUsersHiddenFromOrdinaryRoster confirms a disabled account drops out
// of the roster ordinary users see, while admins still see it (to re-enable it).
func TestDisabledUsersHiddenFromOrdinaryRoster(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)
	aliceC, _ := seedMember(t, ts, st, "alice", "Alice", store.RoleMember)
	_, ghost := seedMember(t, ts, st, "ghost", "Ghost", store.RoleMember)

	// Admin disables ghost.
	resp, body := doJSON(t, adminC, "PUT", ts.URL+"/api/admin/users/"+itoa(ghost.ID)+"/active",
		map[string]bool{"active": false})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("disable ghost: %d %s", resp.StatusCode, body)
	}

	hasGhost := func(c *http.Client) bool {
		_, b := doJSON(t, c, "GET", ts.URL+"/api/users", nil)
		var users []store.User
		json.Unmarshal(b, &users)
		for _, u := range users {
			if u.ID == ghost.ID {
				return true
			}
		}
		return false
	}

	if hasGhost(aliceC) {
		t.Fatalf("ordinary user should not see a disabled account in the roster")
	}
	if !hasGhost(adminC) {
		t.Fatalf("admin should still see the disabled account")
	}
}

// TestLeaveAndRemovePrivateChannel covers leaving a private channel (self) and
// the moderator-removes-other path, plus the guards (public 400, DM 403,
// non-member 404, removing someone else as a non-mod 403).
func TestLeaveAndRemovePrivateChannel(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, admin := seedAdmin(t, ts, st)
	daveC, dave := seedMember(t, ts, st, "dave", "Dave", store.RoleMember)
	mollyC, _ := seedMember(t, ts, st, "molly", "Molly", store.RoleModerator)

	// Admin creates a private channel (auto-joined) and invites Dave.
	_, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "secret", "is_private": true})
	var ch store.Channel
	json.Unmarshal(body, &ch)
	doJSON(t, adminC, "POST", ts.URL+"/api/channels/"+itoa(ch.ID)+"/members", map[string]int64{"user_id": dave.ID})

	// A non-member non-mod (Molly isn't in the channel) can't remove someone.
	resp, _ := doJSON(t, daveC, "DELETE", ts.URL+"/api/channels/"+itoa(ch.ID)+"/members/"+itoa(admin.ID), nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member removing another should be 403, got %d", resp.StatusCode)
	}

	// Dave leaves (self-removal).
	resp, lb := doJSON(t, daveC, "DELETE", ts.URL+"/api/channels/"+itoa(ch.ID)+"/members/"+itoa(dave.ID), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("leave: %d %s", resp.StatusCode, lb)
	}
	// Now Dave can't read it and it's gone from his list.
	resp, _ = doJSON(t, daveC, "GET", ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages", nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("after leaving, reading should be 403, got %d", resp.StatusCode)
	}
	// Leaving again -> 404 (not a member).
	resp, _ = doJSON(t, daveC, "DELETE", ts.URL+"/api/channels/"+itoa(ch.ID)+"/members/"+itoa(dave.ID), nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("leaving twice should be 404, got %d", resp.StatusCode)
	}

	// A moderator may remove another member: re-add Dave, then Molly removes him.
	// (Molly must be a member to act here in spirit, but mod+ is allowed regardless.)
	doJSON(t, adminC, "POST", ts.URL+"/api/channels/"+itoa(ch.ID)+"/members", map[string]int64{"user_id": dave.ID})
	resp, rb := doJSON(t, mollyC, "DELETE", ts.URL+"/api/channels/"+itoa(ch.ID)+"/members/"+itoa(dave.ID), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("moderator remove: %d %s", resp.StatusCode, rb)
	}

	// Public channels have no membership to leave (400).
	_, body = doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	var pub store.Channel
	json.Unmarshal(body, &pub)
	resp, _ = doJSON(t, adminC, "DELETE", ts.URL+"/api/channels/"+itoa(pub.ID)+"/members/"+itoa(admin.ID), nil)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("leaving a public channel should be 400, got %d", resp.StatusCode)
	}

	// You can't leave a DM via this endpoint (403).
	_, body = doJSON(t, adminC, "POST", ts.URL+"/api/dms", map[string]int64{"user_id": dave.ID})
	var dm store.Channel
	json.Unmarshal(body, &dm)
	resp, _ = doJSON(t, adminC, "DELETE", ts.URL+"/api/channels/"+itoa(dm.ID)+"/members/"+itoa(admin.ID), nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("leaving a DM should be 403, got %d", resp.StatusCode)
	}
}

// TestDMPinByParticipant confirms either DM participant (not just moderators) can
// pin/unpin, while pinning in a normal channel still requires moderator+.
func TestDMPinByParticipant(t *testing.T) {
	ts, st, _ := newTestServer(t)
	seedAdmin(t, ts, st)
	aliceC, _ := seedMember(t, ts, st, "alice", "Alice", store.RoleMember)
	bobC, bob := seedMember(t, ts, st, "bob", "Bob", store.RoleMember)

	// Alice opens a DM with Bob and posts.
	_, body := doJSON(t, aliceC, "POST", ts.URL+"/api/dms", map[string]int64{"user_id": bob.ID})
	var dm store.Channel
	json.Unmarshal(body, &dm)
	msg := postMessage(t, aliceC, ts, dm.ID, "pin me")

	// Bob — a plain member, but a participant — can pin Alice's message.
	resp, pb := doJSON(t, bobC, "PUT", ts.URL+"/api/messages/"+itoa(msg.ID)+"/pin", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("DM participant pin: %d %s", resp.StatusCode, pb)
	}
	var pinned store.Message
	json.Unmarshal(pb, &pinned)
	if pinned.PinnedAt == nil {
		t.Fatalf("message should be pinned: %s", pb)
	}
	// And unpin.
	resp, _ = doJSON(t, bobC, "DELETE", ts.URL+"/api/messages/"+itoa(msg.ID)+"/pin", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("DM participant unpin: %d", resp.StatusCode)
	}

	// In a normal channel, a plain member still cannot pin.
	adminC, _ := seedMember(t, ts, st, "boss", "Boss", store.RoleAdmin)
	_, body = doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	var pub store.Channel
	json.Unmarshal(body, &pub)
	pubMsg := postMessage(t, adminC, ts, pub.ID, "no touchy")
	resp, _ = doJSON(t, bobC, "PUT", ts.URL+"/api/messages/"+itoa(pubMsg.ID)+"/pin", nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member pinning in a normal channel should be 403, got %d", resp.StatusCode)
	}
}

// TestMuteSilencesChannel confirms a muted channel drops out of the unread
// summary entirely, and unmuting brings the counts back.
func TestMuteSilencesChannel(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)
	aliceC, _ := seedMember(t, ts, st, "alice", "Alice", store.RoleMember)
	bobC, _ := seedMember(t, ts, st, "bob", "Bob", store.RoleMember)

	_, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	var general store.Channel
	json.Unmarshal(body, &general)
	postMessage(t, aliceC, ts, general.ID, "one")
	postMessage(t, aliceC, ts, general.ID, "two @bob")

	// Baseline: bob is behind by two, one of them a ping.
	if cu := chUnread(getUnread(t, bobC, ts), general.ID); cu.Unread != 2 || cu.Mentions != 1 {
		t.Fatalf("baseline unread: got %+v, want unread=2 mentions=1", cu)
	}

	// Mute → the channel contributes nothing to unread or mentions.
	resp, mb := doJSON(t, bobC, "PUT", ts.URL+"/api/channels/"+itoa(general.ID)+"/mute", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("mute: %d %s", resp.StatusCode, mb)
	}
	u := getUnread(t, bobC, ts)
	if cu := chUnread(u, general.ID); cu.Unread != 0 || cu.Mentions != 0 {
		t.Fatalf("muted channel should be silent, got %+v", cu)
	}
	if u.TotalUnread != 0 || u.TotalMentions != 0 {
		t.Fatalf("totals should be zero while muted, got %d/%d", u.TotalUnread, u.TotalMentions)
	}
	// The muted set is reported so the client can dim the row.
	if len(u.Muted) != 1 || u.Muted[0] != general.ID {
		t.Fatalf("muted list = %v, want [%d]", u.Muted, general.ID)
	}

	// Unmute → the still-unread messages reappear.
	resp, _ = doJSON(t, bobC, "DELETE", ts.URL+"/api/channels/"+itoa(general.ID)+"/mute", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unmute: %d", resp.StatusCode)
	}
	if cu := chUnread(getUnread(t, bobC, ts), general.ID); cu.Unread != 2 || cu.Mentions != 1 {
		t.Fatalf("after unmute, unread should return, got %+v", cu)
	}
}

func TestGetMessagesAround(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)

	resp, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create channel: %d %s", resp.StatusCode, body)
	}
	var ch store.Channel
	json.Unmarshal(body, &ch)

	// Post 10 messages; collect IDs in order.
	ids := make([]int64, 10)
	for i := range ids {
		_, b := doJSON(t, adminC, "POST", ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages",
			map[string]string{"content": "m" + itoa(int64(i))})
		var m store.Message
		json.Unmarshal(b, &m)
		ids[i] = m.ID
	}

	getAround := func(msgID int64) []store.Message {
		_, b := doJSON(t, adminC, "GET",
			ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages?around="+itoa(msgID), nil)
		var out []store.Message
		json.Unmarshal(b, &out)
		return out
	}

	// Around the middle message (ids[4]): should include ids[4] and neighbours.
	mid := getAround(ids[4])
	if len(mid) == 0 {
		t.Fatal("around middle: got empty result")
	}
	// Must be sorted ascending.
	for i := 1; i < len(mid); i++ {
		if mid[i].ID <= mid[i-1].ID {
			t.Fatalf("around middle: not sorted ascending at index %d: %v", i, mid)
		}
	}
	// Anchor must be present.
	found := false
	for _, m := range mid {
		if m.ID == ids[4] {
			found = true
		}
	}
	if !found {
		t.Fatalf("around middle: anchor message %d missing from result", ids[4])
	}

	// Around the first message (ids[0]): no older messages, only anchor + newer.
	first := getAround(ids[0])
	if first[0].ID != ids[0] {
		t.Fatalf("around first: expected first element to be anchor %d, got %d", ids[0], first[0].ID)
	}
	for _, m := range first {
		if m.ID < ids[0] {
			t.Fatalf("around first: got message with id < anchor: %d", m.ID)
		}
	}

	// Around the last message (ids[9]): no newer messages, only older + anchor.
	last := getAround(ids[9])
	if last[len(last)-1].ID != ids[9] {
		t.Fatalf("around last: expected last element to be anchor %d, got %d", ids[9], last[len(last)-1].ID)
	}
	for _, m := range last {
		if m.ID > ids[9] {
			t.Fatalf("around last: got message with id > anchor: %d", m.ID)
		}
	}

	// Non-existent message ID → 404.
	resp404, _ := doJSON(t, adminC, "GET",
		ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages?around=999999999", nil)
	if resp404.StatusCode != http.StatusNotFound {
		t.Fatalf("around non-existent: expected 404, got %d", resp404.StatusCode)
	}

	// Wrong channel (message exists but in a different channel) → 404.
	resp2, b2 := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "other"})
	if resp2.StatusCode != http.StatusCreated {
		t.Fatalf("create other channel: %d %s", resp2.StatusCode, b2)
	}
	var ch2 store.Channel
	json.Unmarshal(b2, &ch2)
	respWrong, _ := doJSON(t, adminC, "GET",
		ts.URL+"/api/channels/"+itoa(ch2.ID)+"/messages?around="+itoa(ids[4]), nil)
	if respWrong.StatusCode != http.StatusNotFound {
		t.Fatalf("around wrong channel: expected 404, got %d", respWrong.StatusCode)
	}
}

func TestListMessagesAfter(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)

	resp, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create channel: %d %s", resp.StatusCode, body)
	}
	var ch store.Channel
	json.Unmarshal(body, &ch)

	ids := make([]int64, 10)
	for i := range ids {
		_, b := doJSON(t, adminC, "POST", ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages",
			map[string]string{"content": "m" + itoa(int64(i))})
		var m store.Message
		json.Unmarshal(b, &m)
		ids[i] = m.ID
	}

	getAfter := func(msgID int64) []store.Message {
		_, b := doJSON(t, adminC, "GET",
			ts.URL+"/api/channels/"+itoa(ch.ID)+"/messages?after="+itoa(msgID), nil)
		var out []store.Message
		json.Unmarshal(b, &out)
		return out
	}

	// After ids[4]: exactly the five newer messages, ascending, none <= anchor.
	after := getAfter(ids[4])
	if len(after) != 5 {
		t.Fatalf("after middle: expected 5 newer messages, got %d", len(after))
	}
	for i, m := range after {
		if m.ID <= ids[4] {
			t.Fatalf("after middle: got id %d <= anchor %d", m.ID, ids[4])
		}
		if i > 0 && m.ID <= after[i-1].ID {
			t.Fatalf("after middle: not sorted ascending at %d: %v", i, after)
		}
	}

	// After the last message: nothing newer — an empty array, never null.
	last := getAfter(ids[9])
	if last == nil {
		t.Fatal("after last: expected [], got null")
	}
	if len(last) != 0 {
		t.Fatalf("after last: expected empty, got %d", len(last))
	}
}

// TestSearchMessages covers full-text search end to end: stemmed matching,
// newest-first ordering, keyset pagination, deleted-message exclusion, the
// []-not-null contract, and — most importantly — access scoping, so a caller
// can never match a message in a private channel or DM they can't see.
func TestSearchMessages(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)
	aliceC, _ := seedMember(t, ts, st, "alice", "Alice", store.RoleMember)
	_, bob := seedMember(t, ts, st, "bob", "Bob", store.RoleMember)
	mollyC, _ := seedMember(t, ts, st, "molly", "Molly", store.RoleModerator)

	// search runs a query as a given client and returns the decoded results. It
	// also asserts the body is a JSON array, never null (the client iterates it).
	search := func(c *http.Client, query string) []store.Message {
		t.Helper()
		resp, body := doJSON(t, c, "GET", ts.URL+"/api/search?q="+query, nil)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("search %q: %d %s", query, resp.StatusCode, body)
		}
		if strings.TrimSpace(string(body)) == "null" {
			t.Fatalf("search %q returned null, must be []", query)
		}
		var out []store.Message
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatalf("decode search %q: %v (%s)", query, err, body)
		}
		return out
	}
	hasID := func(ms []store.Message, id int64) bool {
		for _, m := range ms {
			if m.ID == id {
				return true
			}
		}
		return false
	}

	// A public channel anyone can see.
	resp, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create public channel: %d %s", resp.StatusCode, body)
	}
	var pub store.Channel
	json.Unmarshal(body, &pub)

	// "deploying" stems to "deploy" under the english config, so a search for
	// "deploy" must match it; the unrelated line must not.
	pub1 := postMessage(t, adminC, ts, pub.ID, "we are deploying the server tonight")
	postMessage(t, adminC, ts, pub.ID, "completely unrelated lunch chatter")
	pub2 := postMessage(t, aliceC, ts, pub.ID, "another deploy update landed")

	// Newest-first: pub2 before pub1, and the unrelated message is absent.
	got := search(aliceC, "deploy")
	if len(got) != 2 {
		t.Fatalf("expected 2 deploy hits, got %d: %+v", len(got), got)
	}
	if got[0].ID != pub2.ID || got[1].ID != pub1.ID {
		t.Fatalf("expected newest-first [%d,%d], got [%d,%d]", pub2.ID, pub1.ID, got[0].ID, got[1].ID)
	}

	// Deleting a hit removes it from results.
	resp, _ = doJSON(t, aliceC, "DELETE", ts.URL+"/api/messages/"+itoa(pub2.ID), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete own message: %d", resp.StatusCode)
	}
	if got = search(aliceC, "deploy"); len(got) != 1 || got[0].ID != pub1.ID {
		t.Fatalf("deleted hit should be gone, got %+v", got)
	}

	// Scoping: a private channel Alice is NOT in. Admin (creator) is a member.
	resp, body = doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{
		"name": "secret-plans", "is_private": true,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create private channel: %d %s", resp.StatusCode, body)
	}
	var priv store.Channel
	json.Unmarshal(body, &priv)
	privMsg := postMessage(t, adminC, ts, priv.ID, "secret deploy of the rocket")

	// Alice (non-member) must not match it; admin (member) must; a moderator
	// who is not a member must not see it (only admins get the bypass).
	if hasID(search(aliceC, "deploy"), privMsg.ID) {
		t.Fatal("non-member matched a private-channel message")
	}
	if !hasID(search(adminC, "deploy"), privMsg.ID) {
		t.Fatal("member should match their private-channel message")
	}
	if hasID(search(mollyC, "deploy"), privMsg.ID) {
		t.Fatal("non-member moderator must not match a private-channel message")
	}

	// Scoping: a DM between admin and bob is members-only — even a moderator may
	// not match it.
	resp, body = doJSON(t, adminC, "POST", ts.URL+"/api/dms", map[string]int64{"user_id": bob.ID})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("open DM: %d %s", resp.StatusCode, body)
	}
	var dm store.Channel
	json.Unmarshal(body, &dm)
	dmMsg := postMessage(t, adminC, ts, dm.ID, "deploy from inside the dm")
	if !hasID(search(adminC, "deploy"), dmMsg.ID) {
		t.Fatal("DM participant should match their own DM message")
	}
	if hasID(search(aliceC, "deploy"), dmMsg.ID) {
		t.Fatal("outsider matched a DM message")
	}
	if hasID(search(mollyC, "deploy"), dmMsg.ID) {
		t.Fatal("moderator matched a DM they aren't part of")
	}

	// A blank query is a 200 with [], not an error (the client clears the box).
	resp, body = doJSON(t, aliceC, "GET", ts.URL+"/api/search?q=", nil)
	if resp.StatusCode != http.StatusOK || strings.TrimSpace(string(body)) != "[]" {
		t.Fatalf("blank query should be 200 []: %d %s", resp.StatusCode, body)
	}
	// A query with no matches is also [] (never null).
	if got = search(aliceC, "zzznomatchxyz"); len(got) != 0 {
		t.Fatalf("no-match query should be empty, got %+v", got)
	}

	// Keyset pagination: limit=1 returns the newest live hit; before=<id> pages
	// to the next older one. (Alice's live "deploy" hits are pub1 only in public,
	// so add a second public hit to have two to page through.)
	pub3 := postMessage(t, adminC, ts, pub.ID, "yet another deploy ping")
	resp, body = doJSON(t, aliceC, "GET", ts.URL+"/api/search?q=deploy&limit=1", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("paged search: %d %s", resp.StatusCode, body)
	}
	var page1 []store.Message
	json.Unmarshal(body, &page1)
	if len(page1) != 1 || page1[0].ID != pub3.ID {
		t.Fatalf("page1 should be newest hit %d, got %+v", pub3.ID, page1)
	}
	resp, body = doJSON(t, aliceC, "GET", ts.URL+"/api/search?q=deploy&limit=1&before="+itoa(pub3.ID), nil)
	var page2 []store.Message
	json.Unmarshal(body, &page2)
	if len(page2) != 1 || page2[0].ID != pub1.ID {
		t.Fatalf("page2 should be next older hit %d, got %+v", pub1.ID, page2)
	}
}

// TestAudienceMirrorsAccess locks the realtime audience to the access model:
// a non-DM private channel's audience includes admins (who can read and write
// it without membership), so an admin posting into a channel they aren't a
// member of receives their own broadcast echo. Moderators no longer get this
// bypass — only their own memberships determine their audience. A DM's
// audience stays members-only — even an admin who isn't a participant is
// excluded.
func TestAudienceMirrorsAccess(t *testing.T) {
	ts, st, cfg := newTestServer(t)
	adminC, admin := seedAdmin(t, ts, st)
	mollyC, molly := seedMember(t, ts, st, "molly", "Molly", store.RoleModerator)
	_, alice := seedMember(t, ts, st, "alice", "Alice", store.RoleMember)

	// Molly (a moderator) creates a private channel; she's its only member.
	resp, body := doJSON(t, mollyC, "POST", ts.URL+"/api/channels", map[string]any{
		"name": "secret-plans", "is_private": true,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create private channel: %d %s", resp.StatusCode, body)
	}
	var priv store.Channel
	json.Unmarshal(body, &priv)

	// A DM between admin and molly (alice is not a participant).
	resp, body = doJSON(t, adminC, "POST", ts.URL+"/api/dms", map[string]int64{"user_id": molly.ID})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("open DM: %d %s", resp.StatusCode, body)
	}
	var dm store.Channel
	json.Unmarshal(body, &dm)

	// audienceForChannel reads only the store, so a fresh Server over the same
	// store computes the same audiences without standing up a second listener.
	srv := New(cfg, st)
	ctx := context.Background()

	privAud := srv.audienceForChannel(ctx, priv)
	if !privAud[admin.ID] {
		t.Error("private-channel audience must include a non-member admin (admin bypass)")
	}
	if !privAud[molly.ID] {
		t.Error("private-channel audience must include its member")
	}
	if privAud[alice.ID] {
		t.Error("private-channel audience must exclude a non-member, non-privileged user")
	}

	dmAud := srv.audienceForChannel(ctx, dm)
	if !dmAud[admin.ID] || !dmAud[molly.ID] {
		t.Error("DM audience must include both participants")
	}
	if dmAud[alice.ID] {
		t.Error("DM audience must exclude a non-participant")
	}
	// The mod+ bypass must NOT leak into DMs: alice is a moderator-free member,
	// but even molly's moderator peer admin only sees this DM because he's a
	// participant. Confirm a privileged outsider is excluded from a DM they're
	// not in by checking a DM that excludes the admin.
	resp, body = doJSON(t, mollyC, "POST", ts.URL+"/api/dms", map[string]int64{"user_id": alice.ID})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("open molly↔alice DM: %d %s", resp.StatusCode, body)
	}
	var dm2 store.Channel
	json.Unmarshal(body, &dm2)
	if aud := srv.audienceForChannel(ctx, dm2); aud[admin.ID] {
		t.Error("an admin must not be in the audience of a DM he isn't part of")
	}
}

func itoa(i int64) string {
	return strconv.FormatInt(i, 10)
}

// doUpload sends a raw body with an explicit content type (the avatar/emoji
// upload shape), carrying the client's session cookie.
func doUpload(t *testing.T, c *http.Client, method, url, contentType string, body []byte) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", contentType)
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	buf := new(bytes.Buffer)
	_, _ = buf.ReadFrom(resp.Body)
	return resp, buf.Bytes()
}

func TestCustomEmojis(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)
	memberC, _ := seedMember(t, ts, st, "alice", "Alice", store.RoleMember)

	// A 1x1 PNG (any non-empty bytes pass the size/empty checks; the content type
	// is what the handler validates).
	img := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4}

	// Empty list serializes as [], never null (the list-endpoint contract).
	resp, body := doJSON(t, memberC, "GET", ts.URL+"/api/emojis", nil)
	if resp.StatusCode != http.StatusOK || strings.TrimSpace(string(body)) != "[]" {
		t.Fatalf("empty emoji list: %d %q", resp.StatusCode, string(body))
	}

	// Members cannot upload.
	resp, _ = doUpload(t, memberC, "POST", ts.URL+"/api/emojis?shortcode=party", "image/png", img)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member upload should be 403, got %d", resp.StatusCode)
	}

	// Moderators can manage custom emojis (create + delete), not just admins.
	modC, _ := seedMember(t, ts, st, "mallory", "Mallory", store.RoleModerator)
	resp, body = doUpload(t, modC, "POST", ts.URL+"/api/emojis?shortcode=modparty", "image/png", img)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("moderator upload: %d %s", resp.StatusCode, body)
	}
	resp, _ = doJSON(t, modC, "DELETE", ts.URL+"/api/emojis/modparty", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("moderator delete should be 200, got %d", resp.StatusCode)
	}

	// Bad shortcode is rejected.
	resp, _ = doUpload(t, adminC, "POST", ts.URL+"/api/emojis?shortcode=Bad-Code", "image/png", img)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad shortcode should be 400, got %d", resp.StatusCode)
	}

	// Wrong content type is rejected.
	resp, _ = doUpload(t, adminC, "POST", ts.URL+"/api/emojis?shortcode=party", "text/plain", img)
	if resp.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("non-image should be 415, got %d", resp.StatusCode)
	}

	// Admin uploads a valid emoji.
	resp, body = doUpload(t, adminC, "POST", ts.URL+"/api/emojis?shortcode=party", "image/png", img)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("admin upload: %d %s", resp.StatusCode, body)
	}
	var created store.Emoji
	json.Unmarshal(body, &created)
	if created.Shortcode != "party" {
		t.Fatalf("created shortcode = %q", created.Shortcode)
	}

	// Duplicate shortcode conflicts.
	resp, _ = doUpload(t, adminC, "POST", ts.URL+"/api/emojis?shortcode=party", "image/png", img)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate shortcode should be 409, got %d", resp.StatusCode)
	}

	// Members can list and fetch the image, and the bytes round-trip.
	resp, body = doJSON(t, memberC, "GET", ts.URL+"/api/emojis", nil)
	var list []store.Emoji
	json.Unmarshal(body, &list)
	if len(list) != 1 || list[0].Shortcode != "party" {
		t.Fatalf("emoji list = %s", string(body))
	}
	resp, body = doJSON(t, memberC, "GET", ts.URL+"/api/emojis/party/image", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get image: %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "image/png" {
		t.Fatalf("image content type = %q", ct)
	}
	if !bytes.Equal(body, img) {
		t.Fatalf("image bytes did not round-trip")
	}

	// Members cannot delete.
	resp, _ = doJSON(t, memberC, "DELETE", ts.URL+"/api/emojis/party", nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member delete should be 403, got %d", resp.StatusCode)
	}

	// Admin deletes; the image then 404s and a second delete is 404.
	resp, body = doJSON(t, adminC, "DELETE", ts.URL+"/api/emojis/party", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("admin delete: %d %s", resp.StatusCode, body)
	}
	resp, _ = doJSON(t, memberC, "GET", ts.URL+"/api/emojis/party/image", nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("deleted image should 404, got %d", resp.StatusCode)
	}
	resp, _ = doJSON(t, adminC, "DELETE", ts.URL+"/api/emojis/party", nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("re-delete should 404, got %d", resp.StatusCode)
	}
}

func TestBotTokenAuth(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminClient, admin := seedAdmin(t, ts, st)

	// Member cannot create bot tokens.
	ctx := context.Background()
	member, _ := st.CreateUser(ctx, "member1", "Member", store.RoleMember)
	memberPw, _ := auth.HashPassword("pw123")
	_ = st.SetPassword(ctx, member.ID, memberPw)
	memberClient := newClient(t)
	doJSON(t, memberClient, "POST", ts.URL+"/api/auth/login", map[string]string{"username": "member1", "password": "pw123"})
	resp, _ := doJSON(t, memberClient, "POST", ts.URL+"/api/admin/bot-tokens", map[string]any{"name": "x"})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member create bot token: want 403, got %d", resp.StatusCode)
	}

	// Admin creates a token for themselves.
	resp, body := doJSON(t, adminClient, "POST", ts.URL+"/api/admin/bot-tokens",
		map[string]any{"name": "claude-bridge"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create bot token: %d %s", resp.StatusCode, body)
	}
	var created struct {
		ID     int64  `json:"id"`
		UserID int64  `json:"user_id"`
		Name   string `json:"name"`
		Token  string `json:"token"`
	}
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if created.Token == "" {
		t.Fatal("token field missing from creation response")
	}
	if created.UserID != admin.ID {
		t.Fatalf("user_id: want %d, got %d", admin.ID, created.UserID)
	}

	// Bearer token authenticates as the owning user.
	req, _ := http.NewRequest("GET", ts.URL+"/api/me", nil)
	req.Header.Set("Authorization", "Bearer "+created.Token)
	meresp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer meresp.Body.Close()
	if meresp.StatusCode != http.StatusOK {
		t.Fatalf("bearer /api/me: want 200, got %d", meresp.StatusCode)
	}
	var me store.User
	json.NewDecoder(meresp.Body).Decode(&me)
	if me.ID != admin.ID {
		t.Fatalf("bearer identity: want user %d, got %d", admin.ID, me.ID)
	}

	// List shows the new token (no raw value).
	resp, body = doJSON(t, adminClient, "GET", ts.URL+"/api/admin/bot-tokens", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list bot tokens: %d %s", resp.StatusCode, body)
	}
	var list []struct {
		ID    int64  `json:"id"`
		Token string `json:"token"`
	}
	json.Unmarshal(body, &list)
	if len(list) != 1 || list[0].ID != created.ID {
		t.Fatalf("list: want 1 token id %d, got %v", created.ID, list)
	}
	if list[0].Token != "" {
		t.Fatal("list response must not include the raw token")
	}

	// Revoke the token.
	resp, _ = doJSON(t, adminClient, "DELETE", ts.URL+"/api/admin/bot-tokens/"+strconv.FormatInt(created.ID, 10), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete bot token: want 200, got %d", resp.StatusCode)
	}

	// Revoked token is rejected.
	req2, _ := http.NewRequest("GET", ts.URL+"/api/me", nil)
	req2.Header.Set("Authorization", "Bearer "+created.Token)
	rev, _ := http.DefaultClient.Do(req2)
	rev.Body.Close()
	if rev.StatusCode != http.StatusUnauthorized {
		t.Fatalf("revoked token: want 401, got %d", rev.StatusCode)
	}
}

// TestSetBotFlag guards PUT /api/admin/users/{id}/bot: admin-only, toggleable,
// persisted, and broadcast. Bots' online status derives from users.status (not
// hub presence) — that invariant is covered by handleListUsers, not here.
func TestSetBotFlag(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)
	memberC, member := seedMember(t, ts, st, "pippin", "Pippin", store.RoleMember)

	// Non-admin cannot set the bot flag.
	resp, _ := doJSON(t, memberC, "PUT", ts.URL+"/api/admin/users/"+itoa(member.ID)+"/bot",
		map[string]bool{"bot": true})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member set bot: want 403, got %d", resp.StatusCode)
	}

	// Admin sets is_bot = true; response carries the updated user.
	resp, body := doJSON(t, adminC, "PUT", ts.URL+"/api/admin/users/"+itoa(member.ID)+"/bot",
		map[string]bool{"bot": true})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("set bot: %d %s", resp.StatusCode, body)
	}
	var u store.User
	if err := json.Unmarshal(body, &u); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !u.IsBot {
		t.Fatalf("is_bot should be true after setting it")
	}

	// Admin clears the flag again.
	resp, body = doJSON(t, adminC, "PUT", ts.URL+"/api/admin/users/"+itoa(member.ID)+"/bot",
		map[string]bool{"bot": false})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("clear bot: %d %s", resp.StatusCode, body)
	}
	json.Unmarshal(body, &u)
	if u.IsBot {
		t.Fatalf("is_bot should be false after clearing it")
	}
}

// TestBlobUploadAndServe covers the full upload→serve lifecycle: POST a valid PNG,
// get back a hash+URL, then GET the URL and verify the bytes come back intact.
// It also checks the content-sniffing rejection path.
func TestBlobUploadAndServe(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)

	// Minimal valid 1×1 PNG (51 bytes, verified by http.DetectContentType).
	minPNG := []byte{
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
		0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
		0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
		0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
		0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
		0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
		0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
		0x44, 0xae, 0x42, 0x60, 0x82,
	}

	upload := func(body []byte, ct string) (*http.Response, map[string]any) {
		req, _ := http.NewRequest("POST", ts.URL+"/api/uploads", bytes.NewReader(body))
		req.Header.Set("Content-Type", ct)
		resp, err := adminC.Do(req)
		if err != nil {
			t.Fatalf("upload request: %v", err)
		}
		defer resp.Body.Close()
		var m map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&m)
		return resp, m
	}

	t.Run("upload valid PNG", func(t *testing.T) {
		resp, m := upload(minPNG, "image/png")
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("want 201, got %d", resp.StatusCode)
		}
		hash, _ := m["hash"].(string)
		rawURL, _ := m["url"].(string)
		if len(hash) != 64 {
			t.Fatalf("hash should be 64-char hex, got %q", hash)
		}
		if rawURL != "/api/blobs/"+hash {
			t.Errorf("url mismatch: %q", rawURL)
		}

		// Fetch the blob back.
		getResp, err := adminC.Get(ts.URL + rawURL)
		if err != nil {
			t.Fatalf("get blob: %v", err)
		}
		defer getResp.Body.Close()
		if getResp.StatusCode != http.StatusOK {
			t.Fatalf("want 200, got %d", getResp.StatusCode)
		}
		got := new(bytes.Buffer)
		_, _ = got.ReadFrom(getResp.Body)
		if !bytes.Equal(got.Bytes(), minPNG) {
			t.Error("round-tripped bytes differ from original")
		}
		if ct := getResp.Header.Get("Content-Type"); ct != "image/png" {
			t.Errorf("content-type: got %q, want image/png", ct)
		}
		cc := getResp.Header.Get("Cache-Control")
		if !strings.Contains(cc, "immutable") {
			t.Errorf("cache-control should be immutable, got %q", cc)
		}
	})

	t.Run("dedup: same bytes → same hash, no error", func(t *testing.T) {
		resp1, m1 := upload(minPNG, "image/png")
		resp2, m2 := upload(minPNG, "image/png")
		if resp1.StatusCode != http.StatusCreated || resp2.StatusCode != http.StatusCreated {
			t.Fatalf("want 201/201, got %d/%d", resp1.StatusCode, resp2.StatusCode)
		}
		if m1["hash"] != m2["hash"] {
			t.Errorf("same bytes should produce same hash: %v vs %v", m1["hash"], m2["hash"])
		}
	})

	t.Run("rejects non-image (sniff, not header)", func(t *testing.T) {
		// Send actual text bytes but claim it's PNG — sniff overrides header.
		resp, _ := upload([]byte("not an image at all"), "image/png")
		if resp.StatusCode != http.StatusUnsupportedMediaType {
			t.Errorf("want 415 for non-image bytes, got %d", resp.StatusCode)
		}
	})

	t.Run("rejects empty body", func(t *testing.T) {
		resp, _ := upload(nil, "image/png")
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("want 400 for empty body, got %d", resp.StatusCode)
		}
	})

	t.Run("invalid hash returns 404", func(t *testing.T) {
		getResp, err := adminC.Get(ts.URL + "/api/blobs/notahash")
		if err != nil {
			t.Fatal(err)
		}
		getResp.Body.Close()
		if getResp.StatusCode != http.StatusNotFound {
			t.Errorf("want 404 for invalid hash, got %d", getResp.StatusCode)
		}
	})

	t.Run("unauthenticated cannot fetch blob", func(t *testing.T) {
		_, m := upload(minPNG, "image/png")
		rawURL := m["url"].(string)
		resp, err := http.Get(ts.URL + rawURL)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("want 401, got %d", resp.StatusCode)
		}
	})
}
