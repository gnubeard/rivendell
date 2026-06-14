package httpapi

import (
	"errors"
	"log"
	"net/http"
	"strings"

	"rivendell/internal/store"
)

// --- channels ------------------------------------------------------------

func (s *Server) handleListChannels(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	channels, err := s.st.ListChannels(r.Context(), u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list channels")
		return
	}
	// Which DMs this user has open is server-authoritative (the dm_open table),
	// so a new device shows only the DMs they've actually kept open, not every
	// DM they've ever started.
	openDMs, err := s.st.OpenDMChannelIDs(r.Context(), u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list channels")
		return
	}
	// Filter private channels the user can't see. Fresh non-nil slice so an
	// empty result serializes as [] (JSON null breaks the client's iteration).
	visible := make([]store.Channel, 0, len(channels))
	for _, ch := range channels {
		if !ch.IsPrivate {
			visible = append(visible, ch)
			continue
		}
		member, err := s.st.IsChannelMember(r.Context(), ch.ID, u.ID)
		isMember := err == nil && member
		// DMs are visible only to their two participants — a moderator/admin
		// must NOT see other people's DMs — and only when the participant has
		// the DM open in their sidebar.
		if ch.IsDM {
			if isMember && openDMs[ch.ID] {
				visible = append(visible, ch)
			}
			continue
		}
		if isMember || roleRank(u.Role) >= roleRank(store.RoleAdmin) {
			visible = append(visible, ch)
		}
	}
	writeJSON(w, http.StatusOK, visible)
}

func (s *Server) handleCreateChannel(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var req struct {
		Name      string `json:"name"`
		Topic     string `json:"topic"`
		IsPrivate bool   `json:"is_private"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	req.Name = strings.ToLower(strings.TrimSpace(req.Name))
	if !reChannel.MatchString(req.Name) {
		writeErr(w, http.StatusBadRequest, "channel name must be 1-48 chars of a-z, 0-9, or hyphen")
		return
	}
	if len(req.Topic) > 256 {
		writeErr(w, http.StatusBadRequest, "topic must be at most 256 characters")
		return
	}
	ch, err := s.st.CreateChannel(r.Context(), req.Name, req.Topic, req.IsPrivate, u.ID)
	if err != nil {
		if store.IsUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "a channel with that name already exists")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not create channel")
		return
	}
	// Creator joins private channels they make.
	if ch.IsPrivate {
		_ = s.st.AddChannelMember(r.Context(), ch.ID, u.ID)
	}
	s.broadcast("channel.new", ch, s.audienceForChannel(r.Context(), ch))
	writeJSON(w, http.StatusCreated, ch)
}

func (s *Server) handleUpdateChannel(w http.ResponseWriter, r *http.Request) {
	id, ok := requirePathInt(w, r, "id", "invalid channel id")
	if !ok {
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	var req struct {
		Topic    *string `json:"topic"`
		Position *int    `json:"position"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	topic := ch.Topic
	if req.Topic != nil {
		topic = *req.Topic
		if len(topic) > 256 {
			writeErr(w, http.StatusBadRequest, "topic must be at most 256 characters")
			return
		}
	}
	position := ch.Position
	if req.Position != nil {
		position = *req.Position
	}
	if err := s.st.UpdateChannel(r.Context(), id, topic, position); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update channel")
		return
	}
	updated, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load updated channel")
		return
	}
	s.broadcast("channel.update", updated, s.audienceForChannel(r.Context(), updated))
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleArchiveChannel(w http.ResponseWriter, r *http.Request) {
	id, ok := requirePathInt(w, r, "id", "invalid channel id")
	if !ok {
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if err := s.st.ArchiveChannel(r.Context(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not archive channel")
		return
	}
	s.broadcast("channel.archive", map[string]int64{"id": id}, s.audienceForChannel(r.Context(), ch))
	writeJSON(w, http.StatusOK, map[string]string{"status": "archived"})
}

// handleCreateDM create-or-finds the two-member private channel between the
// caller and another user. Available to any authenticated user (a DM is just a
// private channel with two people in it).
func (s *Server) handleCreateDM(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var req struct {
		UserID int64 `json:"user_id"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	other, err := s.st.GetUserByID(r.Context(), req.UserID)
	if err != nil || !other.IsActive {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	ch, created, err := s.st.GetOrCreateDM(r.Context(), u.ID, other.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not open DM")
		return
	}
	if created {
		// A brand-new DM opens for both participants (mirroring the channel.new
		// broadcast that surfaces it on each side immediately).
		if _, err := s.st.OpenDMForAllMembers(r.Context(), ch.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not open DM")
			return
		}
		// Only announce a freshly-created DM, and only to its two members (the
		// audience scoping); the caller gets the channel in the HTTP response.
		s.broadcast("channel.new", ch, s.audienceForChannel(r.Context(), ch))
	} else if err := s.st.OpenDM(r.Context(), u.ID, ch.ID); err != nil {
		// Re-opening an existing DM (e.g. clicking a name to resurrect a closed
		// one) opens it for the caller only; the other side reopens on a message.
		writeErr(w, http.StatusInternalServerError, "could not open DM")
		return
	}
	// Refetch using the caller's opened_at so an explicitly-opened DM — even one
	// with an old last message — sorts to the top for this user.
	full, err := s.st.GetDMWithRecencyForUser(r.Context(), ch.ID, u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not open DM")
		return
	}
	ch = full
	writeJSON(w, http.StatusOK, ch)
}

// handleCloseDM hides a DM from the caller's sidebar. It's server-authoritative
// and per-user: the channel, its membership, and its history are untouched (the
// other participant is unaffected), and the DM reopens for the caller on the
// next message. Only a participant may close their own DM.
func (s *Server) handleCloseDM(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id, ok := requirePathInt(w, r, "id", "invalid channel id")
	if !ok {
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil || !ch.IsDM {
		writeErr(w, http.StatusNotFound, "DM not found")
		return
	}
	member, err := s.st.IsChannelMember(r.Context(), ch.ID, u.ID)
	if err != nil || !member {
		writeErr(w, http.StatusForbidden, "not a participant in this DM")
		return
	}
	if err := s.st.CloseDM(r.Context(), u.ID, ch.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not close DM")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "closed"})
}

// handleGetChannel returns a single channel by id if the caller can access it.
// Used by the client to resolve closed DMs that are absent from the initial
// channel list (e.g. to label search results or reopen on a permalink click).
func (s *Server) handleGetChannel(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	ch, ok := s.requireChannelAccess(w, r, u)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, ch)
}

// handleListChannelMembers lists the members of a channel the caller can access.
func (s *Server) handleListChannelMembers(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	ch, ok := s.requireChannelAccess(w, r, u)
	if !ok {
		return
	}
	members, err := s.st.ListChannelMembers(r.Context(), ch.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list members")
		return
	}
	writeJSON(w, http.StatusOK, members)
}

// handleAddChannelMember invites a user to a private channel. Only moderators+
// may invite, and only into a real private channel — DMs are fixed at two
// participants and public channels have no membership.
func (s *Server) handleAddChannelMember(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id, ok := requirePathInt(w, r, "id", "invalid channel id")
	if !ok {
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if !ch.IsPrivate {
		writeErr(w, http.StatusBadRequest, "public channels have no membership to manage")
		return
	}
	if ch.IsDM {
		writeErr(w, http.StatusForbidden, "a DM is limited to its two participants")
		return
	}
	if roleRank(u.Role) < roleRank(store.RoleModerator) {
		writeErr(w, http.StatusForbidden, "only moderators can invite to this channel")
		return
	}
	var req struct {
		UserID int64 `json:"user_id"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	target, err := s.st.GetUserByID(r.Context(), req.UserID)
	if err != nil || !target.IsActive {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	if err := s.st.AddChannelMember(r.Context(), ch.ID, target.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not add member")
		return
	}
	// Start the invitee caught up on this channel's backlog rather than facing it
	// all as unread.
	if err := s.st.SeedReadCursor(r.Context(), target.ID, ch.ID); err != nil {
		log.Printf("addChannelMember: seed read cursor: %v", err)
	}
	// Re-broadcast the channel to the (now-larger) audience so the newly-added
	// member's client learns the channel exists in realtime.
	s.broadcast("channel.new", ch, s.audienceForChannel(r.Context(), ch))
	writeJSON(w, http.StatusOK, target)
}

// handleRemoveChannelMember removes a user from a private channel. A user may
// always remove themselves (leave); removing someone else requires moderator+.
// Public channels have no membership and DMs are fixed at two participants, so
// both are refused.
func (s *Server) handleRemoveChannelMember(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id, ok := requirePathInt(w, r, "id", "invalid channel id")
	if !ok {
		return
	}
	target, ok := requirePathInt(w, r, "userId", "invalid user id")
	if !ok {
		return
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if !ch.IsPrivate {
		writeErr(w, http.StatusBadRequest, "public channels have no membership to manage")
		return
	}
	if ch.IsDM {
		writeErr(w, http.StatusForbidden, "a DM is fixed at its two participants")
		return
	}
	// Self-removal (leave) is always allowed; removing others needs moderator+.
	if target != u.ID && roleRank(u.Role) < roleRank(store.RoleModerator) {
		writeErr(w, http.StatusForbidden, "you can only remove yourself from this channel")
		return
	}
	// Capture the audience (current members, INCLUDING the one leaving) before the
	// removal, so one event reaches both the departing user and everyone who
	// stays. (An admin viewing via bypass isn't a member and so isn't notified
	// live — consistent with how other private-channel events are scoped; they'll
	// see the change on next open.)
	audience := s.audienceForChannel(r.Context(), ch)
	if err := s.st.RemoveChannelMember(r.Context(), id, target); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not a member of this channel")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not remove member")
		return
	}
	// Auto-archive the channel when the last member leaves.
	if n, err := s.st.CountChannelMembers(r.Context(), id); err != nil {
		log.Printf("removeChannelMember: count for auto-archive: %v", err)
	} else if n == 0 {
		if err := s.st.ArchiveChannel(r.Context(), id); err != nil {
			log.Printf("auto-archive empty channel %d: %v", id, err)
		} else {
			s.broadcast("channel.archive", map[string]int64{"id": id}, audience)
			writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
			return
		}
	}
	// One event does both jobs: the departing user's clients drop the channel,
	// and remaining members drop them from the roster — no re-fetch needed.
	s.broadcast("member.remove", map[string]int64{"channel_id": id, "user_id": target}, audience)
	writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
}

// --- messages ------------------------------------------------------------

func (s *Server) canAccessChannel(r *http.Request, ch store.Channel, u store.User) bool {
	return s.channelVisibleTo(r.Context(), ch, u)
}

// requireChannelAccess parses the channel id from the path, fetches the channel,
// and checks the caller's access. On failure it writes the appropriate HTTP error
// and returns false; the caller should return immediately when ok is false.
func (s *Server) requireChannelAccess(w http.ResponseWriter, r *http.Request, u store.User) (store.Channel, bool) {
	id, ok := requirePathInt(w, r, "id", "invalid channel id")
	if !ok {
		return store.Channel{}, false
	}
	ch, err := s.st.GetChannel(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return store.Channel{}, false
	}
	if !s.canAccessChannel(r, ch, u) {
		writeErr(w, http.StatusForbidden, "no access to this channel")
		return store.Channel{}, false
	}
	return ch, true
}

// accessibleChannelIDs returns the ids of every channel the user may read —
// the same visibility canAccessChannel enforces per-channel, applied across the
// whole channel list. Used to scope full-text search so a caller can never match
// a message in a private channel or DM they aren't part of.
func (s *Server) accessibleChannelIDs(r *http.Request, u store.User) ([]int64, error) {
	channels, err := s.st.ListChannels(r.Context(), u.ID)
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(channels))
	for _, ch := range channels {
		if s.canAccessChannel(r, ch, u) {
			ids = append(ids, ch.ID)
		}
	}
	return ids, nil
}
