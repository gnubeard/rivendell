package ws

import (
	"log"
	"sync"
	"time"
)

// Hub tracks connected clients and fans out events. A user is "online" while
// they hold at least one connection (multiple tabs/devices are fine). Presence
// transitions invoke the OnPresence callback so the application layer can
// persist status and broadcast a presence event.
type Hub struct {
	mu         sync.Mutex
	byUser     map[int64]map[*Client]struct{}
	idle       map[int64]bool // ephemeral idle flag; cleared on last disconnect
	onPresence func(userID int64, online bool)
}

// Client is one WebSocket connection belonging to a user.
type Client struct {
	hub    *Hub
	conn   *Conn
	userID int64
	send   chan []byte
	closed chan struct{}
	once   sync.Once
}

func NewHub(onPresence func(userID int64, online bool)) *Hub {
	return &Hub{
		byUser:     make(map[int64]map[*Client]struct{}),
		idle:       make(map[int64]bool),
		onPresence: onPresence,
	}
}

// Serve registers a connection and blocks running its read loop until the
// connection closes. Intended to be called from an HTTP handler after Accept.
func (h *Hub) Serve(conn *Conn, userID int64, welcome ...[]byte) {
	c := &Client{
		hub:    h,
		conn:   conn,
		userID: userID,
		send:   make(chan []byte, 64),
		closed: make(chan struct{}),
	}
	becameOnline := h.add(c)
	if becameOnline && h.onPresence != nil {
		h.onPresence(userID, true)
	}
	go c.writePump()
	// Optional per-connection welcome frame(s) sent before the read loop blocks —
	// e.g. the server version, so the client can detect it's running against a
	// newer build after a reconnect.
	for _, w := range welcome {
		if w == nil {
			continue
		}
		select {
		case c.send <- w:
		default:
		}
	}
	c.readPump() // blocks until the peer disconnects
	becameOffline := h.remove(c)
	if becameOffline && h.onPresence != nil {
		h.onPresence(userID, false)
	}
}

func (h *Hub) add(c *Client) (firstForUser bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	conns := h.byUser[c.userID]
	if conns == nil {
		conns = make(map[*Client]struct{})
		h.byUser[c.userID] = conns
		firstForUser = true
	}
	conns[c] = struct{}{}
	return firstForUser
}

func (h *Hub) remove(c *Client) (lastForUser bool) {
	c.once.Do(func() { close(c.closed) })
	h.mu.Lock()
	defer h.mu.Unlock()
	conns := h.byUser[c.userID]
	if conns == nil {
		return false
	}
	delete(conns, c)
	if len(conns) == 0 {
		delete(h.byUser, c.userID)
		delete(h.idle, c.userID) // ephemeral: clear idle on last disconnect
		return true
	}
	return false
}

// Broadcast delivers data to every connection whose userID is in audience.
// A nil audience means everyone. Slow clients that can't keep up are dropped.
func (h *Hub) Broadcast(data []byte, audience map[int64]bool) {
	h.mu.Lock()
	targets := make([]*Client, 0, 32)
	for uid, conns := range h.byUser {
		if audience != nil && !audience[uid] {
			continue
		}
		for c := range conns {
			targets = append(targets, c)
		}
	}
	h.mu.Unlock()

	for _, c := range targets {
		select {
		case c.send <- data:
		default:
			// Backpressure: the client is too slow; drop and close it.
			log.Printf("ws: dropping slow client user=%d", c.userID)
			c.conn.Close()
		}
	}
}

// ConnectedCount returns the number of distinct users with at least one live connection.
func (h *Hub) ConnectedCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.byUser)
}

// OnlineUserIDs returns the set of users with at least one live connection.
func (h *Hub) OnlineUserIDs() []int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]int64, 0, len(h.byUser))
	for uid := range h.byUser {
		out = append(out, uid)
	}
	return out
}

// SetIdle marks the user idle (true) or active (false). Returns true if the
// user currently has at least one open connection and the flag was recorded.
// Returns false and is a no-op when the user has no connections.
func (h *Hub) SetIdle(userID int64, idle bool) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.byUser[userID] == nil {
		return false
	}
	if idle {
		h.idle[userID] = true
	} else {
		delete(h.idle, userID)
	}
	return true
}

// IsIdle reports whether the user's idle flag is set.
func (h *Hub) IsIdle(userID int64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.idle[userID]
}

func (c *Client) writePump() {
	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
	for {
		select {
		case data := <-c.send:
			if err := c.conn.WriteText(data); err != nil {
				c.conn.Close()
				return
			}
		case <-ping.C:
			if err := c.conn.Ping(); err != nil {
				c.conn.Close()
				return
			}
		case <-c.closed:
			return
		}
	}
}

func (c *Client) readPump() {
	defer c.conn.Close()
	for {
		c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
		// Inbound client messages (typing, etc.) are accepted but not required
		// by the first draft; messages are sent over the REST API. Reading here
		// keeps the connection's liveness detection and pong handling working.
	}
}
