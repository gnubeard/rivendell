package httpapi

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"rivendell/internal/store"
)

// TestRingDismissesSiblingConnections guards the multi-login fix: when a callee
// is connected on more than one tab/device, every connection is rung, but only
// the one that answers (or declines) handles the ring. The others must be told
// to stop ringing — via a voice.ring_dismissed event, NOT a relayed
// ring_response (which would make a second tab also join the call). Before the
// fix the sibling connection kept ringing until the 30s timeout.
func TestRingDismissesSiblingConnections(t *testing.T) {
	ts, st, _ := newTestServer(t)
	ctx := context.Background()

	callerC, caller := seedAdmin(t, ts, st)
	calleeC, callee := seedMember(t, ts, st, "frodo", "Frodo", store.RoleMember)

	dm, _, err := st.GetOrCreateDM(ctx, caller.ID, callee.ID)
	if err != nil {
		t.Fatalf("create dm: %v", err)
	}

	callerConn, callerR := wsDial(t, ts, callerC)
	defer callerConn.Close()
	calleeConn1, calleeR1 := wsDial(t, ts, calleeC)
	defer calleeConn1.Close()
	calleeConn2, calleeR2 := wsDial(t, ts, calleeC)
	defer calleeConn2.Close()

	// Caller rings the DM. Both of the callee's connections should ring.
	wsSend(t, callerConn, map[string]any{"type": "voice.ring", "dm_channel_id": dm.ID})
	wsExpect(t, calleeConn1, calleeR1, "voice.ring")
	wsExpect(t, calleeConn2, calleeR2, "voice.ring")

	// Callee answers on connection 1.
	wsSend(t, calleeConn1, map[string]any{"type": "voice.ring_response", "dm_channel_id": dm.ID, "accept": true})

	// The caller gets the answer...
	wsExpect(t, callerConn, callerR, "voice.ring_response")
	// ...and the callee's OTHER connection is told to stop ringing.
	wsExpect(t, calleeConn2, calleeR2, "voice.ring_dismissed")
}

// --- minimal WebSocket test client (stdlib only, matches the hand-rolled
// server in internal/ws). The server accepts unmasked client frames, so the
// writer doesn't bother masking; the reader skips control frames and any
// unrelated events (presence, the hello welcome) until it sees the wanted type.

func wsDial(t *testing.T, ts *httptest.Server, c *http.Client) (net.Conn, *bufio.Reader) {
	t.Helper()
	u, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	conn, err := net.Dial("tcp", u.Host)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	var cookie strings.Builder
	for i, ck := range c.Jar.Cookies(u) {
		if i > 0 {
			cookie.WriteString("; ")
		}
		cookie.WriteString(ck.Name + "=" + ck.Value)
	}
	req := "GET /api/ws HTTP/1.1\r\n" +
		"Host: " + u.Host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Version: 13\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
		"Cookie: " + cookie.String() + "\r\n\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatalf("write handshake: %v", err)
	}
	r := bufio.NewReader(conn)
	status, err := r.ReadString('\n')
	if err != nil || !strings.Contains(status, "101") {
		t.Fatalf("ws handshake failed: %q (%v)", status, err)
	}
	for { // consume the rest of the response headers up to the blank line
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("read handshake headers: %v", err)
		}
		if line == "\r\n" || line == "\n" {
			break
		}
	}
	return conn, r
}

func wsSend(t *testing.T, conn net.Conn, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal frame: %v", err)
	}
	if len(b) >= 126 {
		t.Fatalf("test frame too large (%d bytes); reader path not implemented", len(b))
	}
	frame := append([]byte{0x81, byte(len(b))}, b...) // FIN + text opcode, unmasked
	if _, err := conn.Write(frame); err != nil {
		t.Fatalf("write frame: %v", err)
	}
}

func wsReadFrame(r *bufio.Reader) (opcode byte, payload []byte, err error) {
	var hdr [2]byte
	if _, err = io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	opcode = hdr[0] & 0x0f
	masked := hdr[1]&0x80 != 0
	n := uint64(hdr[1] & 0x7f)
	switch n {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(r, ext[:]); err != nil {
			return 0, nil, err
		}
		n = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(r, ext[:]); err != nil {
			return 0, nil, err
		}
		n = binary.BigEndian.Uint64(ext[:])
	}
	var mask [4]byte
	if masked {
		if _, err = io.ReadFull(r, mask[:]); err != nil {
			return 0, nil, err
		}
	}
	payload = make([]byte, n)
	if _, err = io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return opcode, payload, nil
}

// wsExpect reads frames until it sees a text event of the given type, skipping
// control frames and unrelated events. Fails if it doesn't arrive in time.
func wsExpect(t *testing.T, conn net.Conn, r *bufio.Reader, typ string) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	defer conn.SetReadDeadline(time.Time{})
	for {
		op, payload, err := wsReadFrame(r)
		if err != nil {
			t.Fatalf("waiting for %q: %v", typ, err)
		}
		switch op {
		case 0x8: // close
			t.Fatalf("connection closed while waiting for %q", typ)
		case 0x9, 0xA: // ping / pong
			continue
		case 0x1, 0x2: // text / binary
			var m struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(payload, &m) == nil && m.Type == typ {
				return
			}
		}
	}
}
