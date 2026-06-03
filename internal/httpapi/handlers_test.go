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
		InstanceName:    "rivendell-test",
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
		Name string `json:"name"`
	}
	json.Unmarshal(body, &inst)
	if inst.Name != "rivendell-test" {
		t.Fatalf("instance name = %q, want rivendell-test", inst.Name)
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

func itoa(i int64) string {
	return strconv.FormatInt(i, 10)
}
