package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
)

// WebRTC debug telemetry. When RIVENDELL_DEBUG_TELEMETRY is set, the web client
// (with ?rtcdebug=1, localStorage, or the server-advertised capture flag) batches
// getStats() snapshots and lifecycle events and POSTs them here. We render each as
// a single logfmt line via a dedicated slog logger so a call's timeline can be
// reconstructed straight from stdout — e.g. `grep rtc-telem | grep peer=7` — and so
// a throwaway parser can aggregate a whole call's worth of ticks.
//
// The payload deliberately carries NO self_user_id: like the from_user_id injection
// in the voice signaling relay, the server stamps `self=` from the authenticated
// session, so a client can't forge whose stats these are. Candidate IP addresses are
// never accepted (the wire schema has no field for them) — only candidate types +
// RTT — so logs stay free of raw addresses.

// telemetryBatch is one POST body. DisallowUnknownFields rejects any field not named
// here (including a stray self_user_id), so the wire schema stays in lockstep with
// the client emitter in web/static/rtcdebug.js.
type telemetryBatch struct {
	UA        string           `json:"ua"`
	Snapshots []telemetrySnap  `json:"snapshots"`
	Events    []telemetryEvent `json:"events"`
}

// telemetrySnap is one peer's getStats() sample at one tick.
type telemetrySnap struct {
	CallID       string       `json:"call_id"`
	ChannelID    int64        `json:"channel_id"`
	RemoteUserID int64        `json:"remote_user_id"`
	T            float64      `json:"t"`  // performance.now() ms (monotonic)
	TS           float64      `json:"ts"` // Date.now() ms (wall clock)
	ICE          string       `json:"ice"`
	Conn         string       `json:"conn"`
	Sig          string       `json:"sig"`
	In           *legStats    `json:"in"`
	Out          *legStats    `json:"out"`
	Pair         *pairStats   `json:"pair"`
	VideoEl      *videoElStat `json:"video_el"`
}

// legStats groups a direction's video + audio RTP stats.
type legStats struct {
	V *rtpStats `json:"v"`
	A *rtpStats `json:"a"`
}

// rtpStats is the union of inbound and outbound RTP fields; the client populates
// only those relevant to the direction. Cumulative counters carry both the current
// value and the client-computed delta-since-last-tick (rendered as `cur(+delta)` so
// a stalled counter — the silent-drop / encoder-freeze signal — is obvious at a glance).
type rtpStats struct {
	Codec string `json:"codec"`

	FPS *float64 `json:"fps"`

	// inbound video
	FramesDecoded   *int64 `json:"framesDecoded"`
	FramesDecodedD  *int64 `json:"framesDecoded_d"`
	FramesReceived  *int64 `json:"framesReceived"`
	FramesReceivedD *int64 `json:"framesReceived_d"`
	KeyFrames       *int64 `json:"keyFramesDecoded"`

	// outbound video
	FramesEncoded  *int64 `json:"framesEncoded"`
	FramesEncodedD *int64 `json:"framesEncoded_d"`
	FramesSent     *int64 `json:"framesSent"`
	FramesSentD    *int64 `json:"framesSent_d"`

	// either direction
	Bytes        *int64 `json:"bytes"`
	BytesD       *int64 `json:"bytes_d"`
	PacketsLost  *int64 `json:"packetsLost"`
	PacketsLostD *int64 `json:"packetsLost_d"`
	PLI          *int64 `json:"pli"`

	Jitter *float64 `json:"jitter"`

	// outbound video extras
	QualityLimitation string   `json:"qualityLimitation"`
	TargetBitrate     *float64 `json:"targetBitrate"`
	W                 *int64   `json:"w"`
	H                 *int64   `json:"h"`
	TotalEncodeTime   *float64 `json:"totalEncodeTime"`
	EncoderImpl       string   `json:"encoderImpl"`
	PowerEfficient    *bool    `json:"powerEfficient"`
}

// pairStats is the selected ICE candidate pair: candidate TYPES (host/srflx/relay)
// and RTT only — never raw addresses (there is intentionally no field for them).
type pairStats struct {
	Local  string   `json:"local"`
	Remote string   `json:"remote"`
	RTTMs  *float64 `json:"rttMs"`
}

// videoElStat is the remote <video> element's playback state, which getStats can't
// see — a paused element with climbing decode counters is the "one frame then frozen"
// autoplay symptom.
type videoElStat struct {
	Paused      *bool    `json:"paused"`
	CurrentTime *float64 `json:"currentTime"`
	ReadyState  *int64   `json:"readyState"`
	W           *int64   `json:"w"`
	H           *int64   `json:"h"`
}

// telemetryEvent is a discrete lifecycle event (join/leave, offer/answer, glare,
// ice/conn state change, ice-restart, camera-toggle, getusermedia-error, …).
// data is a free map so new event fields don't require a schema change.
type telemetryEvent struct {
	CallID       string         `json:"call_id"`
	ChannelID    int64          `json:"channel_id"`
	RemoteUserID int64          `json:"remote_user_id"`
	T            float64        `json:"t"`
	TS           float64        `json:"ts"`
	Kind         string         `json:"kind"`
	Data         map[string]any `json:"data"`
}

func (s *Server) handleDebugTelemetry(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.DebugTelemetry {
		// Don't advertise the endpoint's existence on a production instance.
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	u := userFrom(r.Context())
	r.Body = http.MaxBytesReader(w, r.Body, 512<<10)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var b telemetryBatch
	if err := dec.Decode(&b); err != nil {
		// Bad JSON, an unknown field, or an oversized body (MaxBytesReader) all land
		// here; a malformed diagnostic payload isn't worth distinguishing 413 from 400.
		writeErr(w, http.StatusBadRequest, "invalid telemetry")
		return
	}
	s.logTelemetry(u.ID, &b)
	w.WriteHeader(http.StatusNoContent)
}

// logTelemetry renders the batch and emits it through the telemetry logger.
func (s *Server) logTelemetry(self int64, b *telemetryBatch) {
	for _, rec := range telemetryRecords(self, b) {
		s.telemetryLog.LogAttrs(context.Background(), slog.LevelInfo, rec.msg, rec.attrs...)
	}
}

type telemetryRecord struct {
	msg   string
	attrs []slog.Attr
}

// telemetryRecords builds the loggable records for a batch. Pure (no IO) so it's
// unit-testable: feed a batch, assert the rendered attrs (incl. that no IP leaks).
func telemetryRecords(self int64, b *telemetryBatch) []telemetryRecord {
	out := make([]telemetryRecord, 0, len(b.Snapshots)+len(b.Events))
	for i := range b.Snapshots {
		out = append(out, snapRecord(self, b.UA, &b.Snapshots[i]))
	}
	for i := range b.Events {
		out = append(out, eventRecord(self, &b.Events[i]))
	}
	return out
}

func snapRecord(self int64, ua string, s *telemetrySnap) telemetryRecord {
	a := attrBuf{}
	a.str("call", s.CallID)
	a.i64("ch", s.ChannelID)
	a.i64("self", self)
	a.i64("peer", s.RemoteUserID)
	a.str("ice", s.ICE)
	a.str("conn", s.Conn)
	a.str("sig", s.Sig)
	rtp(&a, "in.v", legV(s.In))
	rtp(&a, "in.a", legA(s.In))
	rtp(&a, "out.v", legV(s.Out))
	rtp(&a, "out.a", legA(s.Out))
	if s.Pair != nil {
		a.str("pair", s.Pair.Local+"/"+s.Pair.Remote)
		a.f64("rtt", s.Pair.RTTMs) // seconds-to-ms conversion happens client-side
	}
	if v := s.VideoEl; v != nil {
		a.boolp("vel.paused", v.Paused)
		a.f64("vel.ct", v.CurrentTime)
		a.i64p("vel.rs", v.ReadyState)
		a.res("vel.res", v.W, v.H)
	}
	a.str("ua", ua)
	return telemetryRecord{msg: "rtc-telem.snap", attrs: a.attrs}
}

func eventRecord(self int64, e *telemetryEvent) telemetryRecord {
	a := attrBuf{}
	a.str("call", e.CallID)
	a.i64("ch", e.ChannelID)
	a.i64("self", self)
	a.i64("peer", e.RemoteUserID)
	a.str("kind", e.Kind)
	// Render data keys in sorted order for stable, greppable lines.
	keys := make([]string, 0, len(e.Data))
	for k := range e.Data {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		a.attrs = append(a.attrs, slog.Any(k, e.Data[k]))
	}
	return telemetryRecord{msg: "rtc-telem.evt", attrs: a.attrs}
}

func legV(l *legStats) *rtpStats {
	if l == nil {
		return nil
	}
	return l.V
}
func legA(l *legStats) *rtpStats {
	if l == nil {
		return nil
	}
	return l.A
}

// rtp appends a direction's RTP attrs under the given prefix, emitting only the
// fields that are present (so audio lines don't carry empty video keys, etc.).
func rtp(a *attrBuf, p string, r *rtpStats) {
	if r == nil {
		return
	}
	a.str(p+".codec", r.Codec)
	a.f64(p+".fps", r.FPS)
	a.delta(p+".framesDecoded", r.FramesDecoded, r.FramesDecodedD)
	a.delta(p+".framesRecv", r.FramesReceived, r.FramesReceivedD)
	a.i64p(p+".keyFr", r.KeyFrames)
	a.delta(p+".framesEnc", r.FramesEncoded, r.FramesEncodedD)
	a.delta(p+".framesSent", r.FramesSent, r.FramesSentD)
	a.delta(p+".bytes", r.Bytes, r.BytesD)
	a.delta(p+".lost", r.PacketsLost, r.PacketsLostD)
	a.i64p(p+".pli", r.PLI)
	a.f64(p+".jitter", r.Jitter)
	a.str(p+".ql", r.QualityLimitation)
	a.f64(p+".tbr", r.TargetBitrate)
	a.res(p+".res", r.W, r.H)
	a.f64(p+".encT", r.TotalEncodeTime)
	a.str(p+".enc", r.EncoderImpl)
	a.boolp(p+".pe", r.PowerEfficient)
}

// attrBuf accumulates slog attrs, skipping absent values so lines stay compact.
type attrBuf struct{ attrs []slog.Attr }

func (a *attrBuf) str(k, v string) {
	if v != "" {
		a.attrs = append(a.attrs, slog.String(k, v))
	}
}
func (a *attrBuf) i64(k string, v int64) { a.attrs = append(a.attrs, slog.Int64(k, v)) }
func (a *attrBuf) i64p(k string, v *int64) {
	if v != nil {
		a.attrs = append(a.attrs, slog.Int64(k, *v))
	}
}
func (a *attrBuf) f64(k string, v *float64) {
	if v != nil {
		a.attrs = append(a.attrs, slog.Float64(k, *v))
	}
}
func (a *attrBuf) boolp(k string, v *bool) {
	if v != nil {
		a.attrs = append(a.attrs, slog.Bool(k, *v))
	}
}
func (a *attrBuf) res(k string, w, h *int64) {
	if w != nil && h != nil {
		a.attrs = append(a.attrs, slog.String(k, strconv.FormatInt(*w, 10)+"x"+strconv.FormatInt(*h, 10)))
	}
}

// delta renders a cumulative counter as `cur(+d)` (or `cur` with no baseline) so a
// frozen counter stands out across consecutive ticks.
func (a *attrBuf) delta(k string, cur, d *int64) {
	if cur == nil {
		return
	}
	a.attrs = append(a.attrs, slog.String(k, deltaStr(*cur, d)))
}

func deltaStr(cur int64, d *int64) string {
	if d == nil {
		return strconv.FormatInt(cur, 10)
	}
	if *d >= 0 {
		return fmt.Sprintf("%d(+%d)", cur, *d)
	}
	return fmt.Sprintf("%d(%d)", cur, *d)
}
