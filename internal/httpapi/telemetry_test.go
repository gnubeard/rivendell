package httpapi

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"strings"
	"testing"
)

// validBatch is a representative telemetry POST body (one snapshot + one event)
// built as nested maps so it exercises the real struct decode path.
func validBatch() map[string]any {
	return map[string]any{
		"ua": "TestUA/1.0",
		"snapshots": []any{
			map[string]any{
				"call_id": "abc", "channel_id": 42, "remote_user_id": 7,
				"ice": "connected", "conn": "connected", "sig": "stable",
				"in": map[string]any{
					"v": map[string]any{"codec": "VP8", "framesDecoded": 5400, "framesDecoded_d": 87},
				},
				"pair": map[string]any{"local": "srflx", "remote": "host", "rttMs": 34},
			},
		},
		"events": []any{
			map[string]any{
				"call_id": "abc", "channel_id": 42, "remote_user_id": 7,
				"kind": "ice-restart-attempt", "data": map[string]any{"attempt": 2},
			},
		},
	}
}

func TestDebugTelemetryEnabledAccepts(t *testing.T) {
	ts, st, _, srv := newTestServerSrv(t)
	srv.cfg.DebugTelemetry = true
	var buf bytes.Buffer
	srv.telemetryLog = slog.New(slog.NewTextHandler(&buf, nil))

	c, u := seedAdmin(t, ts, st)
	resp, body := doJSON(t, c, "POST", ts.URL+"/api/debug/telemetry", validBatch())
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("want 204, got %d %s", resp.StatusCode, body)
	}
	out := buf.String()
	// The server stamps self= from the session, NOT from the (absent) payload field.
	if !strings.Contains(out, "self="+itoa(u.ID)) {
		t.Errorf("emitted log missing self=%d: %s", u.ID, out)
	}
	for _, want := range []string{"rtc-telem.snap", "rtc-telem.evt", "peer=7", "pair=srflx/host", "kind=ice-restart-attempt"} {
		if !strings.Contains(out, want) {
			t.Errorf("emitted log missing %q: %s", want, out)
		}
	}
}

func TestDebugTelemetryDisabledIs404(t *testing.T) {
	ts, st, _, srv := newTestServerSrv(t)
	srv.cfg.DebugTelemetry = false // explicit: the feature is off
	c, _ := seedAdmin(t, ts, st)
	resp, _ := doJSON(t, c, "POST", ts.URL+"/api/debug/telemetry", validBatch())
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("disabled telemetry should 404, got %d", resp.StatusCode)
	}
}

func TestDebugTelemetryUnauthenticatedIs401(t *testing.T) {
	ts, _, _, srv := newTestServerSrv(t)
	srv.cfg.DebugTelemetry = true
	c := newClient(t) // no login
	resp, _ := doJSON(t, c, "POST", ts.URL+"/api/debug/telemetry", validBatch())
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", resp.StatusCode)
	}
}

func TestDebugTelemetryUnknownFieldRejected(t *testing.T) {
	ts, st, _, srv := newTestServerSrv(t)
	srv.cfg.DebugTelemetry = true
	c, _ := seedAdmin(t, ts, st)
	resp, _ := doJSON(t, c, "POST", ts.URL+"/api/debug/telemetry", map[string]any{"bogus": 1})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown field should 400, got %d", resp.StatusCode)
	}
}

func TestDebugTelemetryOversizedRejected(t *testing.T) {
	ts, st, _, srv := newTestServerSrv(t)
	srv.cfg.DebugTelemetry = true
	c, _ := seedAdmin(t, ts, st)
	big := map[string]any{"ua": strings.Repeat("x", 600*1024)} // > 512KiB cap
	resp, _ := doJSON(t, c, "POST", ts.URL+"/api/debug/telemetry", big)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("oversized body should 400, got %d", resp.StatusCode)
	}
}

// TestTelemetryRecordsFormat is a pure (no-DB) test of the renderer: delta
// formatting and the structural guarantee that no candidate IP can appear (the
// wire schema has no field to carry one).
func TestTelemetryRecordsFormat(t *testing.T) {
	cur, d, rtt := int64(5400), int64(87), 34.0
	b := &telemetryBatch{
		UA: "TestUA",
		Snapshots: []telemetrySnap{{
			CallID: "abc", ChannelID: 42, RemoteUserID: 7,
			ICE: "connected", Conn: "connected", Sig: "stable",
			In:   &legStats{V: &rtpStats{Codec: "VP8", FramesDecoded: &cur, FramesDecodedD: &d}},
			Pair: &pairStats{Local: "srflx", Remote: "host", RTTMs: &rtt},
		}},
	}
	recs := telemetryRecords(3, b)
	if len(recs) != 1 {
		t.Fatalf("want 1 record, got %d", len(recs))
	}
	var buf bytes.Buffer
	slog.New(slog.NewTextHandler(&buf, nil)).
		LogAttrs(context.Background(), slog.LevelInfo, recs[0].msg, recs[0].attrs...)
	out := buf.String()

	for _, want := range []string{"self=3", "peer=7", "pair=srflx/host", "VP8", "5400(+87)"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in %s", want, out)
		}
	}
	if strings.Contains(out, "address") || strings.Contains(out, "192.") {
		t.Errorf("telemetry leaked an address: %s", out)
	}
}
