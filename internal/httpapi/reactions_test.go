package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"rivendell/internal/store"
)

func TestValidUnicodeEmoji(t *testing.T) {
	good := []string{
		"👍", "❤️", "😂", "🎉", "🔥", "👀", "🙏", "✅", // common single emoji (some carry VS16)
		"🇺🇸",    // regional-indicator flag
		"👍🏽",    // skin-tone modifier sequence
		"👨‍👩‍👧", // ZWJ family sequence
		"5️⃣",   // keycap sequence
	}
	for _, s := range good {
		if !validUnicodeEmoji(s) {
			t.Errorf("expected %q to be a valid reaction emoji", s)
		}
	}

	bad := []string{
		"",                      // empty
		"a",                     // plain letter
		"hello",                 // a word
		"this is text",          // a sentence
		"lol😂",                  // text glued to an emoji
		"👍 ok",                  // emoji plus text
		strings.Repeat("👍", 13), // too many runes
		strings.Repeat("👍", 50), // too many bytes
	}
	for _, s := range bad {
		if validUnicodeEmoji(s) {
			t.Errorf("expected %q to be rejected", s)
		}
	}
}

// reactionResp mirrors the add/remove reaction payload (also broadcast).
type reactionResp struct {
	MessageID int64            `json:"message_id"`
	ChannelID int64            `json:"channel_id"`
	Reactions []store.Reaction `json:"reactions"`
}

// reactGroup returns the reaction group for an emoji, or a zero value.
func reactGroup(rs []store.Reaction, emoji string) store.Reaction {
	for _, r := range rs {
		if r.Emoji == emoji {
			return r
		}
	}
	return store.Reaction{}
}

// firstMessageReactions fetches the channel's messages and returns the reactions
// attached to the given message id (proving the list endpoint decorates them).
func firstMessageReactions(t *testing.T, c *http.Client, ts *httptest.Server, channelID, messageID int64) []store.Reaction {
	t.Helper()
	_, body := doJSON(t, c, "GET", ts.URL+"/api/channels/"+itoa(channelID)+"/messages", nil)
	var msgs []store.Message
	json.Unmarshal(body, &msgs)
	for _, m := range msgs {
		if m.ID == messageID {
			return m.Reactions
		}
	}
	t.Fatalf("message %d not found in list", messageID)
	return nil
}

func TestReactionsAddRemoveAndAggregate(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)
	aliceC, _ := seedMember(t, ts, st, "alice", "Alice", store.RoleMember)

	_, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	var ch store.Channel
	json.Unmarshal(body, &ch)
	msg := postMessage(t, adminC, ts, ch.ID, "react to me")
	rpath := ts.URL + "/api/messages/" + itoa(msg.ID) + "/reactions"

	// Admin reacts 👍.
	resp, body := doJSON(t, adminC, "PUT", rpath, map[string]string{"emoji": "👍"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("add reaction: %d %s", resp.StatusCode, body)
	}
	var rr reactionResp
	json.Unmarshal(body, &rr)
	if g := reactGroup(rr.Reactions, "👍"); len(g.UserIDs) != 1 {
		t.Fatalf("after admin react, 👍 want 1 reactor, got %+v", rr.Reactions)
	}

	// A repeat add by the same user is idempotent (still one reactor).
	doJSON(t, adminC, "PUT", rpath, map[string]string{"emoji": "👍"})

	// Alice also reacts 👍 → count 2; the list endpoint reflects it.
	doJSON(t, aliceC, "PUT", rpath, map[string]string{"emoji": "👍"})
	if g := reactGroup(firstMessageReactions(t, aliceC, ts, ch.ID, msg.ID), "👍"); len(g.UserIDs) != 2 {
		t.Fatalf("after both react, 👍 want 2 reactors, got %+v", g)
	}

	// Admin removes theirs → back to 1.
	resp, body = doJSON(t, adminC, "DELETE", rpath, map[string]string{"emoji": "👍"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("remove reaction: %d %s", resp.StatusCode, body)
	}
	json.Unmarshal(body, &rr)
	if g := reactGroup(rr.Reactions, "👍"); len(g.UserIDs) != 1 {
		t.Fatalf("after admin un-react, 👍 want 1 reactor, got %+v", rr.Reactions)
	}
}

func TestReactionValidation(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, admin := seedAdmin(t, ts, st)

	_, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	var ch store.Channel
	json.Unmarshal(body, &ch)
	msg := postMessage(t, adminC, ts, ch.ID, "hello")
	rpath := ts.URL + "/api/messages/" + itoa(msg.ID) + "/reactions"

	// An unknown custom shortcode is rejected (no backing emoji image).
	resp, _ := doJSON(t, adminC, "PUT", rpath, map[string]string{"emoji": "not_a_real_code"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown shortcode should 400, got %d", resp.StatusCode)
	}
	// Arbitrary text is rejected too.
	resp, _ = doJSON(t, adminC, "PUT", rpath, map[string]string{"emoji": "lol"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("text reaction should 400, got %d", resp.StatusCode)
	}

	// A reaction referencing an existing custom emoji shortcode is accepted.
	if _, err := st.CreateEmoji(context.Background(), "party", "image/png", []byte("img"), admin.ID); err != nil {
		t.Fatalf("create emoji: %v", err)
	}
	resp, b := doJSON(t, adminC, "PUT", rpath, map[string]string{"emoji": "party"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("custom-emoji reaction should be 200, got %d %s", resp.StatusCode, b)
	}
}

func TestReactionOnDeletedMessageRejected(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)

	_, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "general"})
	var ch store.Channel
	json.Unmarshal(body, &ch)
	msg := postMessage(t, adminC, ts, ch.ID, "soon gone")

	// Pre-seed a reaction, then delete the message — the soft-delete must clear it.
	doJSON(t, adminC, "PUT", ts.URL+"/api/messages/"+itoa(msg.ID)+"/reactions", map[string]string{"emoji": "👍"})
	doJSON(t, adminC, "DELETE", ts.URL+"/api/messages/"+itoa(msg.ID), nil)

	// Reacting to a deleted message is refused.
	resp, _ := doJSON(t, adminC, "PUT", ts.URL+"/api/messages/"+itoa(msg.ID)+"/reactions", map[string]string{"emoji": "🎉"})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("react on deleted message should 409, got %d", resp.StatusCode)
	}

	// The deleted message carries no reactions in the list.
	if rs := firstMessageReactions(t, adminC, ts, ch.ID, msg.ID); len(rs) != 0 {
		t.Fatalf("deleted message should have no reactions, got %+v", rs)
	}
}

func TestReactionRequiresChannelAccess(t *testing.T) {
	ts, st, _ := newTestServer(t)
	adminC, _ := seedAdmin(t, ts, st)
	daveC, _ := seedMember(t, ts, st, "dave", "Dave", store.RoleMember)

	// Admin posts in a private channel Dave is not a member of.
	_, body := doJSON(t, adminC, "POST", ts.URL+"/api/channels", map[string]any{"name": "secret", "is_private": true})
	var ch store.Channel
	json.Unmarshal(body, &ch)
	msg := postMessage(t, adminC, ts, ch.ID, "members only")

	resp, _ := doJSON(t, daveC, "PUT", ts.URL+"/api/messages/"+itoa(msg.ID)+"/reactions", map[string]string{"emoji": "👍"})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("non-member reaction should 403, got %d", resp.StatusCode)
	}
}
