package ws

import (
	"log"
	"net"
	"sort"
	"sync"
	"time"
)

// VoiceParticipant describes one user actively in a voice channel.
type VoiceParticipant struct {
	UserID     int64     `json:"user_id"`
	JoinedAt   time.Time `json:"joined_at"`
	Muted      bool      `json:"muted"`
	VideoMuted bool      `json:"video_muted"`
	// Sharing is true while this participant's live video source is a screen
	// share (vs. a camera). It rides the same voice.mute frame as the mute flags
	// and lets peers prioritise a shared screen in the spotlight view. Purely
	// advisory — it never gates media.
	Sharing bool `json:"sharing"`
}

// Hub tracks connected clients and fans out events. A user is "online" while
// they hold at least one connection (multiple tabs/devices are fine). Presence
// transitions invoke the OnPresence callback so the application layer can
// persist status and broadcast a presence event.
type Hub struct {
	mu            sync.Mutex
	byUser        map[int64]map[*Client]struct{}
	onPresence    func(userID int64, online bool)
	onMessage     func(c *Client, data []byte)
	voiceMu       sync.RWMutex
	voiceChannels map[int64]map[int64]*VoiceParticipant // channelID → userID → participant
	// voiceSeq is a monotonic counter stamped onto every voice.state broadcast,
	// assigned under voiceMu at mutation time. Each client connection has its own
	// readPump goroutine, and a voice.state snapshot is taken under the lock but
	// sent AFTER releasing it — so two clients' broadcasts to a third party can
	// arrive out of logical order (a stale roster landing last, showing an avatar
	// over live video). The receiver drops any voice.state whose seq isn't newer
	// than the last it applied. Monotonic across all channels; the client compares
	// per active call. See docs/testing/call-ui-video-staleness.md (bug #2).
	voiceSeq uint64
}

// Client is one WebSocket connection belonging to a user. idle is an ephemeral,
// per-connection flag (guarded by Hub.mu): a user is "idle" only when *every*
// one of their connections is idle, so an active tab keeps them non-idle.
type Client struct {
	hub    *Hub
	conn   *Conn
	userID int64
	idle   bool
	send   chan []byte
	closed chan struct{}
	once   sync.Once
}

// UserID returns the user this connection belongs to.
func (c *Client) UserID() int64 { return c.userID }

func NewHub(onPresence func(userID int64, online bool), onMessage func(c *Client, data []byte)) *Hub {
	return &Hub{
		byUser:        make(map[int64]map[*Client]struct{}),
		onPresence:    onPresence,
		onMessage:     onMessage,
		voiceChannels: make(map[int64]map[int64]*VoiceParticipant),
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
	becameOnline, idleChanged := h.add(c)
	if h.onPresence != nil && (becameOnline || idleChanged) {
		// becameOnline: the user just came online. idleChanged: this fresh
		// (active) connection cleared the user's idle state — e.g. they opened a
		// new tab while another was idle. Either way, refresh everyone's view.
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
	lastForUser, idleChanged := h.remove(c)
	if lastForUser && h.onPresence != nil {
		h.onPresence(userID, false)
	} else if idleChanged && h.onPresence != nil {
		// A non-last connection dropped and flipped the user's effective idle
		// state (e.g. the only active tab closed, leaving idle ones) — refresh.
		h.onPresence(userID, true)
	}
}

func (h *Hub) add(c *Client) (firstForUser, idleChanged bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	conns := h.byUser[c.userID]
	if conns == nil {
		conns = make(map[*Client]struct{})
		h.byUser[c.userID] = conns
		firstForUser = true
	}
	before := h.userIdleLocked(c.userID)
	conns[c] = struct{}{} // new connections start active (c.idle == false)
	return firstForUser, before != h.userIdleLocked(c.userID)
}

func (h *Hub) remove(c *Client) (lastForUser, idleChanged bool) {
	c.once.Do(func() { close(c.closed) })
	h.mu.Lock()
	defer h.mu.Unlock()
	conns := h.byUser[c.userID]
	if conns == nil {
		return false, false
	}
	before := h.userIdleLocked(c.userID)
	delete(conns, c)
	if len(conns) == 0 {
		delete(h.byUser, c.userID) // ephemeral idle dies with the connections
		return true, false
	}
	return false, before != h.userIdleLocked(c.userID)
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

// IsConnected reports whether the user has at least one live WebSocket
// connection. Used to route notifications: connected users get the foreground
// path; disconnected users get a Web Push.
func (h *Hub) IsConnected(userID int64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.byUser[userID]) > 0
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

// SetClientIdle records the idle state of a single connection and reports
// whether the user's *effective* idle state changed as a result. Idle is
// per-connection: a user counts as idle only when every connection they hold is
// idle, so a second, active session keeps them non-idle.
func (h *Hub) SetClientIdle(c *Client, idle bool) (changed bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	before := h.userIdleLocked(c.userID)
	c.idle = idle
	return before != h.userIdleLocked(c.userID)
}

// IsIdle reports whether the user is idle — true only when they hold at least
// one connection and all of them are idle.
func (h *Hub) IsIdle(userID int64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.userIdleLocked(userID)
}

// userIdleLocked computes effective idle for a user. Caller must hold h.mu.
func (h *Hub) userIdleLocked(userID int64) bool {
	conns := h.byUser[userID]
	if len(conns) == 0 {
		return false
	}
	for c := range conns {
		if !c.idle {
			return false
		}
	}
	return true
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
	// 90s is a "no traffic at all" idle timeout: ReadMessage re-arms it before every
	// frame, so the client's ~30s ping/pong cadence keeps a quiet connection alive.
	c.conn.SetReadTimeout(90 * time.Second)
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				log.Printf("ws: read-deadline timeout user=%d", c.userID)
			}
			return
		}
		if c.hub.onMessage != nil && len(data) > 0 {
			c.hub.onMessage(c, data)
		}
	}
}

// SendToUser delivers data to all active connections for a specific user.
func (h *Hub) SendToUser(userID int64, data []byte) {
	h.mu.Lock()
	targets := make([]*Client, 0, 4)
	for c := range h.byUser[userID] {
		targets = append(targets, c)
	}
	h.mu.Unlock()
	for _, c := range targets {
		select {
		case c.send <- data:
		default:
			log.Printf("ws: dropping slow client user=%d", c.userID)
			c.conn.Close()
		}
	}
}

// VoiceJoin adds userID to the voice channel, returning the updated participant
// list and the monotonic seq stamped on the resulting broadcast (see voiceSeq).
func (h *Hub) VoiceJoin(channelID, userID int64) ([]VoiceParticipant, uint64) {
	h.voiceMu.Lock()
	defer h.voiceMu.Unlock()
	if h.voiceChannels[channelID] == nil {
		h.voiceChannels[channelID] = make(map[int64]*VoiceParticipant)
	}
	if _, ok := h.voiceChannels[channelID][userID]; !ok {
		// Default to video-muted: a call starts voice-only so peers don't render a
		// video placeholder before anyone turns a camera on. A camera-on-at-join
		// participant corrects this with an immediate voice.mute (video_muted:false).
		h.voiceChannels[channelID][userID] = &VoiceParticipant{
			UserID:     userID,
			JoinedAt:   time.Now(),
			VideoMuted: true,
		}
	}
	h.voiceSeq++
	return voiceList(h.voiceChannels[channelID]), h.voiceSeq
}

// VoiceLeave removes userID from the voice channel, returning the updated
// participant list and the seq stamped on the resulting broadcast (see voiceSeq).
func (h *Hub) VoiceLeave(channelID, userID int64) ([]VoiceParticipant, uint64) {
	h.voiceMu.Lock()
	defer h.voiceMu.Unlock()
	if m := h.voiceChannels[channelID]; m != nil {
		delete(m, userID)
		if len(m) == 0 {
			delete(h.voiceChannels, channelID)
		}
	}
	h.voiceSeq++
	return voiceList(h.voiceChannels[channelID]), h.voiceSeq
}

// VoiceSetMute updates a participant's muted, video-muted, and screen-sharing
// flags, returning the updated list.
func (h *Hub) VoiceSetMute(channelID, userID int64, muted, videoMuted, sharing bool) ([]VoiceParticipant, uint64) {
	h.voiceMu.Lock()
	defer h.voiceMu.Unlock()
	if m := h.voiceChannels[channelID]; m != nil {
		if p := m[userID]; p != nil {
			p.Muted = muted
			p.VideoMuted = videoMuted
			p.Sharing = sharing
		}
	}
	h.voiceSeq++
	return voiceList(h.voiceChannels[channelID]), h.voiceSeq
}

// VoiceClear removes everyone from a voice channel and returns the user IDs
// that were participating, so the caller can notify them. Used for DM calls,
// which are phone-call style: when one party hangs up (or drops), the call ends
// for both rather than leaving the other stranded alone in the channel.
func (h *Hub) VoiceClear(channelID int64) ([]int64, uint64) {
	h.voiceMu.Lock()
	defer h.voiceMu.Unlock()
	m := h.voiceChannels[channelID]
	ids := make([]int64, 0, len(m))
	for id := range m {
		ids = append(ids, id)
	}
	delete(h.voiceChannels, channelID)
	h.voiceSeq++
	return ids, h.voiceSeq
}

// VoiceParticipants returns a snapshot of who is in a voice channel.
func (h *Hub) VoiceParticipants(channelID int64) []VoiceParticipant {
	h.voiceMu.RLock()
	defer h.voiceMu.RUnlock()
	return voiceList(h.voiceChannels[channelID])
}

// VoiceCounts reports how many users are in a voice channel and how many of
// them currently have a camera on (video unmuted). Used to enforce the group
// caps (total participants, simultaneous cameras) without allocating a list.
// userID is excluded from both counts when already present, so a re-join or a
// camera re-toggle by an existing participant isn't counted against itself.
func (h *Hub) VoiceCounts(channelID, exclude int64) (total, videoOn int) {
	h.voiceMu.RLock()
	defer h.voiceMu.RUnlock()
	for id, p := range h.voiceChannels[channelID] {
		if id == exclude {
			continue
		}
		total++
		if !p.VideoMuted {
			videoOn++
		}
	}
	return total, videoOn
}

// VoiceLeaveAll removes userID from every voice channel they are in. Returns a
// map of channelID → updated participant list for each affected channel, plus the
// seq stamped on those broadcasts (one bump for the whole operation; monotonic
// against any concurrent per-channel mutation — see voiceSeq).
func (h *Hub) VoiceLeaveAll(userID int64) (map[int64][]VoiceParticipant, uint64) {
	h.voiceMu.Lock()
	defer h.voiceMu.Unlock()
	affected := make(map[int64][]VoiceParticipant)
	for chID, m := range h.voiceChannels {
		if _, ok := m[userID]; !ok {
			continue
		}
		delete(m, userID)
		if len(m) == 0 {
			delete(h.voiceChannels, chID)
			affected[chID] = []VoiceParticipant{}
		} else {
			affected[chID] = voiceList(m)
		}
	}
	h.voiceSeq++
	return affected, h.voiceSeq
}

// VoiceAllChannels returns a snapshot of every channel that currently has at
// least one voice participant. Callers must filter by access before exposing.
func (h *Hub) VoiceAllChannels() map[int64][]VoiceParticipant {
	h.voiceMu.RLock()
	defer h.voiceMu.RUnlock()
	out := make(map[int64][]VoiceParticipant, len(h.voiceChannels))
	for chID, m := range h.voiceChannels {
		out[chID] = voiceList(m)
	}
	return out
}

// voiceList converts a participant map to a slice sorted by join time.
// Caller must hold voiceMu (any mode).
func voiceList(m map[int64]*VoiceParticipant) []VoiceParticipant {
	out := make([]VoiceParticipant, 0, len(m))
	for _, p := range m {
		out = append(out, *p)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].JoinedAt.Before(out[j].JoinedAt)
	})
	return out
}
