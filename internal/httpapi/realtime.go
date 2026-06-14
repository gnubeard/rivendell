package httpapi

import (
	"context"
	"encoding/json"
	"log"

	"rivendell/internal/store"
)

// --- realtime events -----------------------------------------------------

type event struct {
	Type    string `json:"type"`
	Payload any    `json:"payload"`
}

func (s *Server) broadcast(typ string, payload any, audience map[int64]bool) {
	data, err := json.Marshal(event{Type: typ, Payload: payload})
	if err != nil {
		log.Printf("broadcast marshal: %v", err)
		return
	}
	s.hub.Broadcast(data, audience)
}

// broadcastUserUpdate reloads user id and fans out a user.update frame so all
// clients refresh their cached copy. The reload error is intentionally
// swallowed: callers invoke this right after writing the row in the same
// request, so a failure here is vanishingly unlikely and not worth failing an
// already-succeeded mutation over. Returns the (possibly zero) reloaded user
// for handlers that echo it in their response body.
func (s *Server) broadcastUserUpdate(ctx context.Context, id int64) store.User {
	updated, _ := s.st.GetUserByID(ctx, id)
	s.broadcast("user.update", updated, nil)
	return updated
}

// channelVisibleTo reports whether u may see ch, using the same logic as
// canAccessChannel but accepting a plain context so it can be called from
// non-HTTP paths (e.g. audienceForChannel).
func (s *Server) channelVisibleTo(ctx context.Context, ch store.Channel, u store.User) bool {
	if !ch.IsPrivate {
		return true
	}
	member, err := s.st.IsChannelMember(ctx, ch.ID, u.ID)
	isMember := err == nil && member
	if ch.IsDM {
		return isMember
	}
	return isMember || roleRank(u.Role) >= roleRank(store.RoleAdmin)
}

// audienceForChannel returns nil (everyone) for public channels, or the set of
// users who may receive a private channel's realtime events. It delegates to
// channelVisibleTo so the visibility predicate has exactly one implementation.
func (s *Server) audienceForChannel(ctx context.Context, ch store.Channel) map[int64]bool {
	if !ch.IsPrivate {
		return nil
	}
	users, err := s.st.ListUsers(ctx)
	if err != nil {
		log.Printf("audienceForChannel: %v", err)
		return map[int64]bool{} // fail closed
	}
	set := make(map[int64]bool, len(users))
	for _, u := range users {
		if s.channelVisibleTo(ctx, ch, u) {
			set[u.ID] = true
		}
	}
	return set
}

// onPresenceChange is invoked by the hub when a user connects/disconnects.
// Connectivity is transient and lives in the hub; we deliberately do NOT write
// it back to users.status, which is the user's *chosen* presence (online/away/
// dnd/offline) and must survive reconnects. The broadcast reports effective
// online = connected AND the user isn't invisible (status "offline"), carrying
// the chosen status so clients can colour the dot.
func (s *Server) onPresenceChange(userID int64, online bool) {
	ctx := context.Background()
	u, err := s.st.GetUserByID(ctx, userID)
	if err != nil {
		log.Printf("presence lookup: %v", err)
		return
	}
	_ = s.st.TouchLastSeen(ctx, userID)
	s.broadcast("presence.update", map[string]any{
		"user_id": userID,
		"online":  online && u.Status != "offline",
		"status":  u.Status,
		"idle":    s.hub.IsIdle(userID),
	}, nil)
	if !online {
		s.cleanupVoiceForUser(ctx, userID)
	}
}
