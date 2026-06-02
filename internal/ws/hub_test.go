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
	})

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
