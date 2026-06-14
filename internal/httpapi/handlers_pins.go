package httpapi

import (
	"errors"
	"net/http"

	"rivendell/internal/store"
)

// handleListPinnedMessages lists a channel's pinned messages (any member who can
// access the channel may view them).
func (s *Server) handleListPinnedMessages(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	ch, ok := s.requireChannelAccess(w, r, u)
	if !ok {
		return
	}
	msgs, err := s.st.ListPinnedMessages(r.Context(), ch.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list pinned messages")
		return
	}
	s.attachReactions(r.Context(), msgs)
	writeJSON(w, http.StatusOK, msgs)
}

// setMessagePinned is shared by the pin (PUT) and unpin (DELETE) handlers, both
// gated to moderator+ at the route. The pinned/unpinned message is broadcast as
// a message.update so clients fold the pinned_at change into their state.
func (s *Server) setMessagePinned(w http.ResponseWriter, r *http.Request, pinned bool) {
	u := userFrom(r.Context())
	id, ok := requirePathInt(w, r, "id", "invalid message id")
	if !ok {
		return
	}
	msg, err := s.st.GetMessage(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "message not found")
		return
	}
	ch, err := s.st.GetChannel(r.Context(), msg.ChannelID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if !s.canAccessChannel(r, ch, u) {
		writeErr(w, http.StatusForbidden, "no access to this channel")
		return
	}
	// In a DM, either participant may pin (canAccessChannel already proved
	// membership). Bots may pin anywhere they have access (they act on behalf of
	// an admin). Everywhere else pinning is a moderator+ action.
	if !ch.IsDM && !u.IsBot && roleRank(u.Role) < roleRank(store.RoleModerator) {
		writeErr(w, http.StatusForbidden, "only moderators can pin in this channel")
		return
	}
	updated, err := s.st.SetMessagePinned(r.Context(), id, u.ID, pinned)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "message not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not update pin")
		return
	}
	s.broadcast("message.update", updated, s.audienceForChannel(r.Context(), ch))
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handlePinMessage(w http.ResponseWriter, r *http.Request) {
	s.setMessagePinned(w, r, true)
}

func (s *Server) handleUnpinMessage(w http.ResponseWriter, r *http.Request) {
	s.setMessagePinned(w, r, false)
}
