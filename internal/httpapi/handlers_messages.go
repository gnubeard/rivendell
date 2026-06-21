package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"rivendell/internal/push"
	"rivendell/internal/store"
)

// pingRecipients returns the user ids a message should ping (notify durably).
// A DM pings every member except the author. Any other channel pings the
// @-mentioned users who can see it (members, for a private channel) plus — when
// the message is a reply — the author of the message being replied to: replying
// to someone is itself a ping, no explicit @-mention required. The author is
// never pinged for their own message, and the result is deduplicated so a reply
// that also @-mentions the parent author counts once. Best-effort: lookup
// failures are logged and yield no pings rather than failing the send.
func (s *Server) pingRecipients(ctx context.Context, ch store.Channel, msg store.Message) []int64 {
	var authorID int64
	if msg.UserID != nil {
		authorID = *msg.UserID
	}
	out := make([]int64, 0, 4)
	seen := make(map[int64]bool)
	add := func(id int64) {
		if id == authorID || seen[id] {
			return
		}
		seen[id] = true
		out = append(out, id)
	}

	if ch.IsDM {
		ids, err := s.st.ListChannelMemberIDs(ctx, ch.ID)
		if err != nil {
			log.Printf("pingRecipients: dm members: %v", err)
			return out
		}
		for _, id := range ids {
			add(id)
		}
		return out // a reply ping is redundant in a DM — both parties ping already
	}

	// For a private channel, only members can be pinged.
	var members map[int64]bool
	if ch.IsPrivate {
		ids, err := s.st.ListChannelMemberIDs(ctx, ch.ID)
		if err != nil {
			log.Printf("pingRecipients: channel members: %v", err)
			return out
		}
		members = make(map[int64]bool, len(ids))
		for _, id := range ids {
			members[id] = true
		}
	}
	pingable := func(id int64) bool { return members == nil || members[id] }

	// @-mentions.
	if names := parseMentions(msg.Content); len(names) > 0 {
		byName, err := s.st.UsersByUsernames(ctx, names)
		if err != nil {
			log.Printf("pingRecipients: resolve usernames: %v", err)
		} else {
			for _, id := range byName {
				if pingable(id) {
					add(id)
				}
			}
		}
	}

	// Reply target: pinging the author you're replying to. The parent posted in
	// this channel, so it had access; still honour the member filter for a private
	// channel to stay consistent with the mention path (fail-closed).
	if msg.ReplyToID != nil {
		if parent, err := s.st.GetMessage(ctx, *msg.ReplyToID); err != nil {
			log.Printf("pingRecipients: reply target: %v", err)
		} else if parent.UserID != nil && pingable(*parent.UserID) {
			add(*parent.UserID)
		}
	}

	return out
}

// recordPings computes and stores the ping rows for a message (used on create
// and, after clearing the old rows, on edit) and returns the recipient ids so a
// caller can drive push delivery from the same list. Best-effort: a failure is
// logged but does not fail the request — the message itself is already persisted.
func (s *Server) recordPings(ctx context.Context, ch store.Channel, msg store.Message) []int64 {
	recipients := s.pingRecipients(ctx, ch, msg)
	if len(recipients) == 0 {
		return recipients
	}
	if err := s.st.RecordMentions(ctx, msg.ID, ch.ID, recipients); err != nil {
		log.Printf("recordPings: %v", err)
	}
	return recipients
}

// sendPushNotifications delivers a Web Push for a new message to every ping
// recipient who is *not* currently connected (a connected user gets the
// foreground WS notification instead) and hasn't muted the channel. Runs in its
// own goroutine off the request path; all delivery is best-effort, and a push
// service reporting a subscription gone (404/410) prunes it.
func (s *Server) sendPushNotifications(ch store.Channel, msg store.Message, recipients []int64) {
	if s.pusher == nil || len(recipients) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var who string
	if msg.UserID != nil {
		author, _ := s.st.GetUserByID(ctx, *msg.UserID)
		who = author.DisplayName
	}
	if who == "" {
		who = "Someone"
	}
	title := who
	if !ch.IsDM {
		title = who + " in #" + ch.Name
	}
	payload, err := pushPayload(ch, msg, title)
	if err != nil {
		log.Printf("push: marshal payload: %v", err)
		return
	}

	for _, uid := range recipients {
		if s.hub.IsConnected(uid) {
			continue
		}
		if muted, err := s.st.IsChannelMuted(ctx, uid, ch.ID); err != nil || muted {
			continue
		}
		subs, err := s.st.ListPushSubscriptions(ctx, uid)
		if err != nil {
			log.Printf("push: list subscriptions for user %d: %v", uid, err)
			continue
		}
		for _, sub := range subs {
			err := s.pusher.Send(ctx, push.Subscription{
				Endpoint: sub.Endpoint, P256dh: sub.P256dh, Auth: sub.Auth,
			}, payload)
			switch {
			case errors.Is(err, push.ErrSubscriptionGone):
				_ = s.st.DeletePushSubscriptionByEndpoint(ctx, sub.Endpoint)
			case err != nil:
				log.Printf("push: send to user %d: %v", uid, err)
			}
		}
	}
}

// pushPayload builds the JSON body of a Web Push for a new message. It carries
// both channelId and messageId so the service worker can re-check the durable
// read cursor and suppress a push for a message already read on another device
// (a push queued while the browser was closed is flushed all at once on launch).
func pushPayload(ch store.Channel, msg store.Message, title string) ([]byte, error) {
	return json.Marshal(map[string]any{
		"title":     title,
		"body":      truncateForPush(msg.Content, 180),
		"channelId": ch.ID,
		"messageId": msg.ID,
		"url":       fmt.Sprintf("/#c%d/m%d", ch.ID, msg.ID),
		"tag":       fmt.Sprintf("rivendell-ch-%d", ch.ID),
	})
}

// truncateForPush bounds a notification body to n runes, appending an ellipsis if
// it was cut. Rune-aware so a multibyte character is never split.
func truncateForPush(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

func (s *Server) handleListMessages(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	ch, ok := s.requireChannelAccess(w, r, u)
	if !ok {
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	if v := r.URL.Query().Get("around"); v != "" {
		aroundID, _ := strconv.ParseInt(v, 10, 64)
		if aroundID > 0 {
			msgs, err := s.st.GetMessagesAround(r.Context(), ch.ID, aroundID, 25)
			if errors.Is(err, store.ErrNotFound) {
				writeErr(w, http.StatusNotFound, "message not found")
				return
			}
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "could not load messages")
				return
			}
			s.attachReactions(r.Context(), msgs)
			writeJSON(w, http.StatusOK, msgs)
			return
		}
	}
	// `after` pages forward (newer) from a cursor — the counterpart to `before` —
	// used when scrolling down through a history window toward the present.
	if v := r.URL.Query().Get("after"); v != "" {
		afterID, _ := strconv.ParseInt(v, 10, 64)
		if afterID > 0 {
			msgs, err := s.st.ListMessagesAfter(r.Context(), ch.ID, afterID, limit)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "could not list messages")
				return
			}
			s.attachReactions(r.Context(), msgs)
			writeJSON(w, http.StatusOK, msgs)
			return
		}
	}
	beforeID := int64(0)
	if v := r.URL.Query().Get("before"); v != "" {
		beforeID, _ = strconv.ParseInt(v, 10, 64)
	}
	msgs, err := s.st.ListMessages(r.Context(), ch.ID, beforeID, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list messages")
		return
	}
	s.attachReactions(r.Context(), msgs)
	writeJSON(w, http.StatusOK, msgs)
}

// handleSearch runs a full-text search over the caller's accessible channels,
// newest match first. Paginates by keyset (`before` = exclusive upper-bound id),
// matching the message-history endpoint. A blank query returns [] rather than an
// error so the client can clear results by emptying the box.
func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusOK, []store.Message{})
		return
	}
	limit := 25
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}
	beforeID := int64(0)
	if v := r.URL.Query().Get("before"); v != "" {
		beforeID, _ = strconv.ParseInt(v, 10, 64)
	}
	ids, err := s.accessibleChannelIDs(r, u)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not search")
		return
	}
	msgs, err := s.st.SearchMessages(r.Context(), ids, q, beforeID, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not search")
		return
	}
	s.attachReactions(r.Context(), msgs)
	writeJSON(w, http.StatusOK, msgs)
}

func (s *Server) handleCreateMessage(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	ch, ok := s.requireChannelAccess(w, r, u)
	if !ok {
		return
	}
	var req struct {
		Content string `json:"content"`
		ReplyTo *int64 `json:"reply_to_id"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	req.Content = strings.TrimRight(req.Content, " \t\r\n")
	if strings.TrimSpace(req.Content) == "" {
		writeErr(w, http.StatusBadRequest, "message is empty")
		return
	}
	if len(req.Content) > s.cfg.MaxMessageBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "message too long")
		return
	}
	// A reply must point at a live message in this same channel. Validate here so a
	// stray/forged reply_to_id can't dangle (or leak that a message exists in another
	// channel). The DB's ON DELETE SET NULL only covers hard-deletes, not soft ones.
	var replyToUserID *int64
	if req.ReplyTo != nil {
		parent, err := s.st.GetMessage(r.Context(), *req.ReplyTo)
		if err != nil || parent.ChannelID != ch.ID || parent.DeletedAt != nil {
			writeErr(w, http.StatusBadRequest, "reply target not found in this channel")
			return
		}
		replyToUserID = parent.UserID
	}
	msg, err := s.st.CreateMessage(r.Context(), ch.ID, u.ID, req.Content, req.ReplyTo)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not send message")
		return
	}
	msg.ReplyToUserID = replyToUserID
	// A message in a DM reopens it for every participant who had closed it
	// (server-authoritative open state). If anyone was reopened, re-announce the
	// channel first so a client that no longer has it in its list gains the
	// channel object before the message.new it precedes.
	if ch.IsDM {
		if reopened, err := s.st.OpenDMForAllMembers(r.Context(), ch.ID); err != nil {
			log.Printf("reopen DM on message: %v", err)
		} else if reopened > 0 {
			s.broadcast("channel.new", ch, s.audienceForChannel(r.Context(), ch))
		}
	}
	// Record durable pings (DM recipients / @-mentions) before broadcasting, so a
	// client that reacts to message.new by re-fetching unread sees them.
	recipients := s.recordPings(r.Context(), ch, msg)
	s.broadcast("message.new", msg, s.audienceForChannel(r.Context(), ch))
	// Offline notifications: push to pinged recipients who aren't connected. Off
	// the request path — push services must never slow a send.
	go s.sendPushNotifications(ch, msg, recipients)
	writeJSON(w, http.StatusCreated, msg)
}

// handleGetMessage fetches a single message by ID, verifying the caller has
// access to the channel it belongs to. Used by the client for message embed
// previews when a same-origin permalink URL appears in a message body.
func (s *Server) handleGetMessage(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id, ok := requirePathInt(w, r, "id", "invalid message id")
	if !ok {
		return
	}
	msg, err := s.st.GetMessage(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "message not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not fetch message")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), msg.ChannelID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not fetch channel")
		return
	}
	if !s.canAccessChannel(r, ch, u) {
		writeErr(w, http.StatusForbidden, "access denied")
		return
	}
	msgs := []store.Message{msg}
	s.attachReactions(r.Context(), msgs)
	writeJSON(w, http.StatusOK, msgs[0])
}

func (s *Server) handleEditMessage(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id, ok := requirePathInt(w, r, "id", "invalid message id")
	if !ok {
		return
	}
	var req struct {
		Content string `json:"content"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	// Trim trailing whitespace before persisting, exactly as handleCreateMessage
	// does — the server is the source of truth for the trim-parity invariant, and
	// an edit must store the same canonical form a fresh send would.
	req.Content = strings.TrimRight(req.Content, " \t\r\n")
	if strings.TrimSpace(req.Content) == "" {
		writeErr(w, http.StatusBadRequest, "message is empty")
		return
	}
	if len(req.Content) > s.cfg.MaxMessageBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "message too long")
		return
	}
	msg, err := s.st.EditMessage(r.Context(), id, u.ID, req.Content)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "message not found or not yours")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not edit message")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), msg.ChannelID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load channel")
		return
	}
	// An edit may add or remove an @-mention; recompute the ping rows from the
	// new content so durable counts stay accurate.
	if err := s.st.DeleteMentionsForMessage(r.Context(), msg.ID); err != nil {
		log.Printf("editMessage: clear mentions: %v", err)
	}
	s.recordPings(r.Context(), ch, msg)
	s.broadcast("message.update", msg, s.audienceForChannel(r.Context(), ch))
	writeJSON(w, http.StatusOK, msg)
}

func (s *Server) handleDeleteMessage(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id, ok := requirePathInt(w, r, "id", "invalid message id")
	if !ok {
		return
	}
	modOverride := roleRank(u.Role) >= roleRank(store.RoleModerator)
	msg, err := s.st.SoftDeleteMessage(r.Context(), id, u.ID, modOverride)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "message not found or not yours")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not delete message")
		return
	}
	// A deleted message should stop pinging anyone.
	if err := s.st.DeleteMentionsForMessage(r.Context(), msg.ID); err != nil {
		log.Printf("deleteMessage: clear mentions: %v", err)
	}
	// ...and shed its reactions (a deleted message renders none).
	if err := s.st.DeleteReactionsForMessage(r.Context(), msg.ID); err != nil {
		log.Printf("deleteMessage: clear reactions: %v", err)
	}
	ch, err := s.st.GetChannel(r.Context(), msg.ChannelID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load channel")
		return
	}
	s.broadcast("message.delete", map[string]int64{
		"id":         msg.ID,
		"channel_id": msg.ChannelID,
	}, s.audienceForChannel(r.Context(), ch))
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// --- read state / notifications ------------------------------------------

// handleUnread returns the caller's durable unread + mention (ping) counts per
// channel, plus the totals. The per-channel list always serializes as an array,
// never null (the client iterates it).
func (s *Server) handleUnread(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	channels, err := s.st.UnreadSummary(r.Context(), u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load unread")
		return
	}
	var totalUnread, totalMentions int
	for _, c := range channels {
		totalUnread += c.Unread
		totalMentions += c.Mentions
	}
	muted, err := s.st.ListMutedChannelIDs(r.Context(), u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load mutes")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"channels":       channels,
		"total_unread":   totalUnread,
		"total_mentions": totalMentions,
		"muted":          muted,
	})
}

// setChannelMuted mutes/unmutes a channel for the caller and echoes the change to
// their other connections (self-audience) so every tab/device stays in sync.
func (s *Server) setChannelMuted(w http.ResponseWriter, r *http.Request, muted bool) {
	u := userFrom(r.Context())
	ch, ok := s.requireChannelAccess(w, r, u)
	if !ok {
		return
	}
	var err error
	if muted {
		err = s.st.MuteChannel(r.Context(), u.ID, ch.ID)
	} else {
		err = s.st.UnmuteChannel(r.Context(), u.ID, ch.ID)
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update mute")
		return
	}
	s.broadcast("mute.update", map[string]any{"channel_id": ch.ID, "muted": muted}, map[int64]bool{u.ID: true})
	writeJSON(w, http.StatusOK, map[string]bool{"muted": muted})
}

func (s *Server) handleMuteChannel(w http.ResponseWriter, r *http.Request) {
	s.setChannelMuted(w, r, true)
}

func (s *Server) handleUnmuteChannel(w http.ResponseWriter, r *http.Request) {
	s.setChannelMuted(w, r, false)
}

// handleMarkRead advances the caller's read cursor for a channel and echoes the
// change to the caller's *other* connections (self-audience) so every tab/device
// clears the badge together.
func (s *Server) handleMarkRead(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	ch, ok := s.requireChannelAccess(w, r, u)
	if !ok {
		return
	}
	var req struct {
		MessageID int64 `json:"message_id"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if err := s.st.MarkRead(r.Context(), u.ID, ch.ID, req.MessageID); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not mark read")
		return
	}
	s.broadcast("read.update", map[string]int64{
		"channel_id":           ch.ID,
		"last_read_message_id": req.MessageID,
	}, map[int64]bool{u.ID: true})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleMarkUnread moves the caller's read cursor backward so that message
// message_id (and everything after it) appears unread. Broadcasts the new
// cursor to the caller's sessions (including the requester's other tabs) as a
// distinct read.unread event so clients re-raise the unread badge rather than
// clearing it the way the read.update (caught-up) path does.
func (s *Server) handleMarkUnread(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	ch, ok := s.requireChannelAccess(w, r, u)
	if !ok {
		return
	}
	var req struct {
		MessageID int64 `json:"message_id"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if req.MessageID <= 0 {
		writeErr(w, http.StatusBadRequest, "message_id required")
		return
	}
	if err := s.st.MarkUnread(r.Context(), u.ID, ch.ID, req.MessageID); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not mark unread")
		return
	}
	cursor := req.MessageID - 1
	s.broadcast("read.unread", map[string]int64{
		"channel_id":           ch.ID,
		"last_read_message_id": cursor,
	}, map[int64]bool{u.ID: true})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
