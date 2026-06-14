package httpapi

import (
	"errors"
	"io"
	"net/http"
	"strings"

	"rivendell/internal/store"
)

// --- custom emojis -------------------------------------------------------

// isImageContentType reports whether ct is one of the image formats we accept
// for user-supplied images (avatars and custom emojis).
func isImageContentType(ct string) bool {
	switch ct {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return true
	}
	return false
}

func (s *Server) handleListEmojis(w http.ResponseWriter, r *http.Request) {
	emojis, err := s.st.ListEmojis(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list emojis")
		return
	}
	writeJSON(w, http.StatusOK, emojis)
}

// handleCreateEmoji stores a custom emoji (admin only). The shortcode arrives as
// a query param and the image as the raw request body — the same upload shape as
// avatars, reusing MaxAvatarBytes as the size ceiling.
func (s *Server) handleCreateEmoji(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	shortcode := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("shortcode")))
	if !reShortcode.MatchString(shortcode) {
		writeErr(w, http.StatusBadRequest, "shortcode must be 2-32 chars of a-z, 0-9, or underscore")
		return
	}
	ct := r.Header.Get("Content-Type")
	if !isImageContentType(ct) {
		writeErr(w, http.StatusUnsupportedMediaType, "emoji must be png, jpeg, webp, or gif")
		return
	}
	body := http.MaxBytesReader(w, r.Body, int64(s.cfg.MaxAvatarBytes))
	data, err := io.ReadAll(body)
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "emoji too large")
		return
	}
	if len(data) == 0 {
		writeErr(w, http.StatusBadRequest, "empty emoji")
		return
	}
	emoji, err := s.st.CreateEmoji(r.Context(), shortcode, ct, data, u.ID)
	if err != nil {
		if store.IsUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "an emoji with that shortcode already exists")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not save emoji")
		return
	}
	// Emojis are instance-wide; everyone learns of the new shortcode in realtime
	// so it renders in messages without a refresh.
	s.broadcast("emoji.add", emoji, nil)
	writeJSON(w, http.StatusCreated, emoji)
}

func (s *Server) handleDeleteEmoji(w http.ResponseWriter, r *http.Request) {
	shortcode := strings.ToLower(r.PathValue("shortcode"))
	if err := s.st.DeleteEmoji(r.Context(), shortcode); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "emoji not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not delete emoji")
		return
	}
	s.broadcast("emoji.delete", map[string]string{"shortcode": shortcode}, nil)
	writeJSON(w, http.StatusOK, map[string]string{"shortcode": shortcode})
}

func (s *Server) handleGetEmojiImage(w http.ResponseWriter, r *http.Request) {
	shortcode := strings.ToLower(r.PathValue("shortcode"))
	mime, data, err := s.st.GetEmojiImage(r.Context(), shortcode)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", mime)
	// Emojis are immutable for a given shortcode (delete + re-add to change the
	// image), so they cache well; longer than avatars since there's no per-id
	// version bust on the client.
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
