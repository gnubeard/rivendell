package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// --- JSON helpers --------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := readJSON(r, v); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	return true
}

func pathInt(r *http.Request, name string) (int64, error) {
	return strconv.ParseInt(r.PathValue(name), 10, 64)
}

// requirePathInt parses an integer path value, writing a 400 with msg and
// returning ok=false if it is missing or malformed. Mirrors decodeBody's
// "guard at the top of the handler" shape: `if !ok { return }`.
func requirePathInt(w http.ResponseWriter, r *http.Request, name, msg string) (int64, bool) {
	id, err := pathInt(r, name)
	if err != nil {
		writeErr(w, http.StatusBadRequest, msg)
		return 0, false
	}
	return id, true
}
