package httpapi

import (
	"context"
	"log"
	"net/http"
	"strings"
	"unicode"

	"rivendell/internal/store"
)

// --- reactions -----------------------------------------------------------

const maxReactionRunes = 12

// attachReactions decorates a page of messages with their reaction groups in a
// single batched query (no N+1). Messages with no reactions are left untouched
// (Reactions stays nil → omitted from JSON). Best-effort: a load failure just
// leaves reactions off rather than failing the whole list.
func (s *Server) attachReactions(ctx context.Context, msgs []store.Message) {
	if len(msgs) == 0 {
		return
	}
	ids := make([]int64, len(msgs))
	for i := range msgs {
		ids[i] = msgs[i].ID
	}
	byID, err := s.st.ReactionsForMessages(ctx, ids)
	if err != nil {
		log.Printf("attachReactions: %v", err)
		return
	}
	for i := range msgs {
		if r := byID[msgs[i].ID]; len(r) > 0 {
			msgs[i].Reactions = r
		}
	}
}

// validReactionEmoji reports whether v is an acceptable reaction value: either a
// known custom shortcode, or a short Unicode emoji grapheme.
func (s *Server) validReactionEmoji(ctx context.Context, v string) bool {
	if reShortcode.MatchString(v) {
		ok, err := s.st.EmojiExists(ctx, v)
		return err == nil && ok
	}
	return validUnicodeEmoji(v)
}

// validUnicodeEmoji is a pragmatic, stdlib-only check (no emoji library — the prime
// directive). Every rune must be a symbol or a recognised emoji connector/modifier,
// and at least one must contribute "emoji-ness" (a symbol or a keycap mark). This
// admits 👍 ❤️ 😂, flags, skin-tone and ZWJ sequences, and keycaps, while rejecting
// words and arbitrary text masquerading as a reaction.
func validUnicodeEmoji(v string) bool {
	if v == "" || len(v) > 64 {
		return false
	}
	n := 0
	sawEmoji := false
	for _, r := range v {
		n++
		if n > maxReactionRunes {
			return false
		}
		switch {
		case unicode.Is(unicode.S, r):
			// Any symbol: pictographs, dingbats, regional-indicator flags, and the
			// skin-tone modifiers (category Sk) all live here.
			sawEmoji = true
		case r == 0x20E3:
			// Combining enclosing keycap — turns a digit/#/* into a keycap emoji.
			sawEmoji = true
		case r == 0x200D, r == 0xFE0F, r == 0xFE0E:
			// Zero-width joiner and the emoji/text variation selectors.
		case (r >= '0' && r <= '9') || r == '#' || r == '*':
			// Keycap bases (paired with U+20E3 above).
		default:
			return false
		}
	}
	return sawEmoji
}

// setReaction is shared by the add (PUT) and remove (DELETE) handlers. Any member
// who can access the channel may react to a visible, non-deleted message; the emoji
// is carried in the body (not the path) so Unicode graphemes need no URL encoding.
// After the change it re-aggregates the message's reactions and broadcasts them as
// reaction.update to the channel audience, mirroring the pin flow.
func (s *Server) setReaction(w http.ResponseWriter, r *http.Request, add bool) {
	u := userFrom(r.Context())
	id, ok := requirePathInt(w, r, "id", "invalid message id")
	if !ok {
		return
	}
	var req struct {
		Emoji string `json:"emoji"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	req.Emoji = strings.TrimSpace(req.Emoji)
	msg, err := s.st.GetMessage(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "message not found")
		return
	}
	if msg.DeletedAt != nil {
		writeErr(w, http.StatusConflict, "cannot react to a deleted message")
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
	// Validate the emoji only on add. A removal must be allowed even when the
	// custom emoji was deleted after the reaction was placed — the DB row itself is
	// proof the value was valid when added, and blocking removal would strand
	// orphaned reactions permanently.
	if add && !s.validReactionEmoji(r.Context(), req.Emoji) {
		writeErr(w, http.StatusBadRequest, "invalid reaction emoji")
		return
	}
	if add {
		err = s.st.AddReaction(r.Context(), id, u.ID, req.Emoji)
	} else {
		err = s.st.RemoveReaction(r.Context(), id, u.ID, req.Emoji)
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update reaction")
		return
	}
	groups, err := s.st.ReactionsForMessage(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load reactions")
		return
	}
	payload := map[string]any{
		"message_id": id,
		"channel_id": msg.ChannelID,
		"reactions":  groups,
	}
	s.broadcast("reaction.update", payload, s.audienceForChannel(r.Context(), ch))
	writeJSON(w, http.StatusOK, payload)
}

func (s *Server) handleAddReaction(w http.ResponseWriter, r *http.Request) {
	s.setReaction(w, r, true)
}

func (s *Server) handleRemoveReaction(w http.ResponseWriter, r *http.Request) {
	s.setReaction(w, r, false)
}
