package httpapi

import (
	"bytes"
	"io"
	"net/http"
	"strconv"
)

// --- blobs ---------------------------------------------------------------

// handleUploadBlob accepts a raw image body, sniffs the content type, hashes it
// (SHA-256), stores it content-addressed on disk, and records metadata in Postgres.
// The upload is idempotent: uploading the same bytes twice returns the same hash.
func (s *Server) handleUploadBlob(w http.ResponseWriter, r *http.Request) {
	if s.blobStore == nil {
		writeErr(w, http.StatusServiceUnavailable, "file uploads not configured")
		return
	}
	u := userFrom(r.Context())
	body := http.MaxBytesReader(w, r.Body, int64(s.cfg.MaxImageBytes))
	data, err := io.ReadAll(body)
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "image too large")
		return
	}
	if len(data) == 0 {
		writeErr(w, http.StatusBadRequest, "empty upload")
		return
	}
	ct := http.DetectContentType(data)
	if !isImageContentType(ct) {
		writeErr(w, http.StatusUnsupportedMediaType, "only png, jpeg, webp, and gif images are accepted")
		return
	}
	hash, size, err := s.blobStore.Put(r.Context(), bytes.NewReader(data))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not store image")
		return
	}
	if err := s.st.CreateBlob(r.Context(), hash, u.ID, ct, size); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not record image")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"hash":         hash,
		"url":          "/api/blobs/" + hash,
		"content_type": ct,
		"size":         size,
	})
}

// handleGetBlob serves a content-addressed image. Auth is required so images
// stay as private as the channels they're posted in. The hash is immutable, so
// a long-lived private cache header is safe.
func (s *Server) handleGetBlob(w http.ResponseWriter, r *http.Request) {
	if s.blobStore == nil {
		http.NotFound(w, r)
		return
	}
	hash := r.PathValue("hash")
	if !isValidBlobHash(hash) {
		http.NotFound(w, r)
		return
	}
	blob, err := s.st.GetBlob(r.Context(), hash)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	rc, err := s.blobStore.Open(r.Context(), hash)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer rc.Close()
	etag := `"` + hash + `"`
	if r.Header.Get("If-None-Match") == etag {
		rc.Close()
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", blob.ContentType)
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("ETag", etag)
	w.Header().Set("Content-Length", strconv.FormatInt(blob.Size, 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, rc)
}

// isValidBlobHash reports whether s is a 64-char lowercase hex string (SHA-256).
func isValidBlobHash(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}
