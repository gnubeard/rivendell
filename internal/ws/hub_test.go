package ws

import (
	"net"
	"testing"
	"time"
)

func TestHubPresenceAndBroadcast(t *testing.T) {
	type pres struct {
		uid    int64
		online bool
	}
	events := make(chan pres, 8)
	hub := NewHub(func(uid int64, online bool) {
		events <- pres{uid, online}
	}, nil)

	serverNC, clientNC := net.Pipe()
	srv := newConn(serverNC)

	done := make(chan struct{})
	go func() {
		hub.Serve(srv, 42)
		close(done)
	}()

	// Expect "online" on first connection.
	select {
	case e := <-events:
		if e.uid != 42 || !e.online {
			t.Fatalf("got %+v, want {42 true}", e)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for online presence")
	}

	if got := hub.OnlineUserIDs(); len(got) != 1 || got[0] != 42 {
		t.Fatalf("OnlineUserIDs = %v, want [42]", got)
	}

	// Broadcast to audience {42} and read it from the client side.
	hub.Broadcast([]byte("hello"), map[int64]bool{42: true})
	clientNC.SetReadDeadline(time.Now().Add(2 * time.Second))
	f, err := readFrame(clientNC)
	if err != nil {
		t.Fatalf("read broadcast frame: %v", err)
	}
	if string(f.payload) != "hello" {
		t.Fatalf("payload = %q, want hello", f.payload)
	}

	// Audience that excludes 42 must not deliver — verify by sending a targeted
	// message then an included one, and checking we only get the included one.
	hub.Broadcast([]byte("nope"), map[int64]bool{99: true})
	hub.Broadcast([]byte("yep"), nil) // nil = everyone
	clientNC.SetReadDeadline(time.Now().Add(2 * time.Second))
	f, err = readFrame(clientNC)
	if err != nil {
		t.Fatalf("read second frame: %v", err)
	}
	if string(f.payload) != "yep" {
		t.Fatalf("payload = %q, want yep (the excluded message leaked)", f.payload)
	}

	// Disconnect → expect "offline".
	clientNC.Close()
	select {
	case e := <-events:
		if e.uid != 42 || e.online {
			t.Fatalf("got %+v, want {42 false}", e)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for offline presence")
	}
	<-done
}

// TestVoiceClear guards the primitive behind DM phone-call semantics: clearing
// a voice channel returns everyone who was in it and leaves the channel empty,
// so the caller can notify each former participant and nobody is stranded.
func TestVoiceClear(t *testing.T) {
	hub := NewHub(nil, nil)
	hub.VoiceJoin(7, 1)
	hub.VoiceJoin(7, 2)

	ids := hub.VoiceClear(7)
	if len(ids) != 2 {
		t.Fatalf("VoiceClear returned %v, want 2 ids", ids)
	}
	got := map[int64]bool{ids[0]: true, ids[1]: true}
	if !got[1] || !got[2] {
		t.Fatalf("VoiceClear returned %v, want {1,2}", ids)
	}
	if p := hub.VoiceParticipants(7); len(p) != 0 {
		t.Fatalf("channel not empty after VoiceClear: %v", p)
	}
	// Clearing an empty/unknown channel is a harmless no-op.
	if ids := hub.VoiceClear(7); len(ids) != 0 {
		t.Fatalf("VoiceClear of empty channel returned %v, want none", ids)
	}
}

// writeClientFrame sends one text frame to the server side of a pipe. readFrame
// accepts unmasked frames, so the test masking dance isn't needed here.
func writeClientFrame(t *testing.T, conn net.Conn, payload []byte) {
	t.Helper()
	if err := writeFrame(conn, true, opText, payload); err != nil {
		t.Fatalf("write client frame: %v", err)
	}
}

func TestHubSetIdle(t *testing.T) {
	ready := make(chan *Client, 1)
	hub := NewHub(nil, nil)

	// IsIdle is false for a user with no connections.
	if hub.IsIdle(42) {
		t.Fatal("IsIdle should be false for disconnected user")
	}

	// Capture the *Client for connection 1 via onMessage (the hub hands it to us).
	hub.onMessage = func(c *Client, _ []byte) { ready <- c }

	serverNC, clientNC := net.Pipe()
	srv := newConn(serverNC)
	done := make(chan struct{})
	go func() { hub.Serve(srv, 42); close(done) }()
	// Send a frame so onMessage fires and we learn the client handle.
	writeClientFrame(t, clientNC, []byte("hi"))
	var c1 *Client
	select {
	case c1 = <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for connection")
	}

	if hub.SetClientIdle(c1, true); !hub.IsIdle(42) {
		t.Fatal("IsIdle should be true after the only connection idles")
	}
	if !hub.SetClientIdle(c1, false) {
		t.Fatal("clearing idle on the only connection should flip effective idle")
	}
	if hub.IsIdle(42) {
		t.Fatal("IsIdle should be false after the connection clears idle")
	}

	// Idle again then disconnect — idle must die with the connection.
	hub.SetClientIdle(c1, true)
	clientNC.Close()
	<-done
	if hub.IsIdle(42) {
		t.Fatal("idle must clear on disconnect")
	}
}

// TestHubIdleMultiSession is the regression for the reported bug: an idle
// session must not make the user idle while another session is active.
func TestHubIdleMultiSession(t *testing.T) {
	clients := make(chan *Client, 2)
	hub := NewHub(nil, func(c *Client, _ []byte) { clients <- c })

	connect := func() (net.Conn, *Client) {
		serverNC, clientNC := net.Pipe()
		go hub.Serve(newConn(serverNC), 7)
		writeClientFrame(t, clientNC, []byte("hi"))
		select {
		case c := <-clients:
			return clientNC, c
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for connection")
			return nil, nil
		}
	}

	ncA, a := connect()
	_, b := connect()

	// B (a background tab) goes idle; A is still active → user is NOT idle.
	if hub.SetClientIdle(b, true) {
		t.Fatal("one of two sessions idling should not flip effective idle")
	}
	if hub.IsIdle(7) {
		t.Fatal("user with an active session must not read as idle")
	}

	// Now A idles too → all sessions idle → user is idle.
	if !hub.SetClientIdle(a, true) {
		t.Fatal("the last active session idling should flip effective idle")
	}
	if !hub.IsIdle(7) {
		t.Fatal("user should be idle once every session is idle")
	}

	// A reconnects with activity (drop A) → only idle B remains → still idle,
	// and the drop should report the (non-)change correctly via remove().
	ncA.Close()
	// Give Serve time to run remove(). Poll IsIdle until B is the sole conn.
	deadline := time.Now().Add(2 * time.Second)
	for hub.ConnectedCount() != 1 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !hub.IsIdle(7) {
		t.Fatal("user should remain idle when only the idle session is left")
	}
}
