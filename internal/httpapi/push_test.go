package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"rivendell/internal/store"
)

// TestPushPayloadCarriesMessageID guards that the push body includes channelId
// AND messageId — the service worker needs both to re-check the durable read
// cursor and suppress a notification for a message already read on another
// device.
func TestPushPayloadCarriesMessageID(t *testing.T) {
	ch := store.Channel{ID: 7, Name: "general"}
	msg := store.Message{ID: 42, Content: "hi there"}

	b, err := pushPayload(ch, msg, "Alice in #general")
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	// JSON numbers decode to float64.
	if got["channelId"] != float64(7) {
		t.Errorf("channelId = %v, want 7", got["channelId"])
	}
	if got["messageId"] != float64(42) {
		t.Errorf("messageId = %v, want 42", got["messageId"])
	}
}

// TestPushKey confirms the server generates a VAPID key on boot and serves it as
// a base64url uncompressed P-256 point (88 chars).
func TestPushKey(t *testing.T) {
	ts, st, _ := newTestServer(t)
	c, _ := seedAdmin(t, ts, st)

	resp, body := doJSON(t, c, "GET", ts.URL+"/api/push/key", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("push key: %d %s", resp.StatusCode, body)
	}
	var got struct {
		Enabled bool   `json:"enabled"`
		Key     string `json:"key"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if !got.Enabled {
		t.Fatal("expected push enabled (VAPID keys generate on boot)")
	}
	if len(got.Key) != 87 { // 65 bytes base64url, unpadded
		t.Errorf("application server key length = %d, want 87", len(got.Key))
	}
}

// TestPushSubscribeLifecycle covers register → persisted → unregister, plus the
// validation guard on a bad endpoint.
func TestPushSubscribeLifecycle(t *testing.T) {
	ts, st, _ := newTestServer(t)
	c, admin := seedAdmin(t, ts, st)

	sub := map[string]any{
		"endpoint": "https://fcm.googleapis.com/fcm/send/abc123",
		"keys": map[string]string{
			"p256dh": "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
			"auth":   "BTBZMqHH6r4Tts7J_aSIgg",
		},
	}
	resp, body := doJSON(t, c, "POST", ts.URL+"/api/push/subscribe", sub)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("subscribe: %d %s", resp.StatusCode, body)
	}

	subs, err := st.ListPushSubscriptions(context.Background(), admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 || subs[0].Endpoint != "https://fcm.googleapis.com/fcm/send/abc123" {
		t.Fatalf("expected one subscription, got %+v", subs)
	}

	// Re-subscribing the same endpoint upserts (no duplicate row).
	doJSON(t, c, "POST", ts.URL+"/api/push/subscribe", sub)
	subs, _ = st.ListPushSubscriptions(context.Background(), admin.ID)
	if len(subs) != 1 {
		t.Fatalf("re-subscribe duplicated: %d rows", len(subs))
	}

	// A non-https endpoint is rejected.
	bad := map[string]any{"endpoint": "http://insecure/x", "keys": map[string]string{"p256dh": "x", "auth": "y"}}
	resp, _ = doJSON(t, c, "POST", ts.URL+"/api/push/subscribe", bad)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("non-https endpoint: got %d, want 400", resp.StatusCode)
	}

	// Unsubscribe clears it.
	resp, body = doJSON(t, c, "POST", ts.URL+"/api/push/unsubscribe", map[string]string{
		"endpoint": "https://fcm.googleapis.com/fcm/send/abc123",
	})
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("unsubscribe: %d %s", resp.StatusCode, body)
	}
	subs, _ = st.ListPushSubscriptions(context.Background(), admin.ID)
	if len(subs) != 0 {
		t.Fatalf("expected no subscriptions after unsubscribe, got %d", len(subs))
	}
}
