package httpapi

import (
	"net/http"
	"strings"
)

// handlePushKey returns whether Web Push is available on this server and, if so,
// the VAPID application server key the browser needs for pushManager.subscribe.
func (s *Server) handlePushKey(w http.ResponseWriter, r *http.Request) {
	if s.pusher == nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "key": s.pusher.PublicKey()})
}

// handlePushSubscribe registers (or refreshes) the caller's browser push
// subscription. The body is the trimmed PushSubscription shape
// {endpoint, keys:{p256dh, auth}}.
func (s *Server) handlePushSubscribe(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var req struct {
		Endpoint string `json:"endpoint"`
		Keys     struct {
			P256dh string `json:"p256dh"`
			Auth   string `json:"auth"`
		} `json:"keys"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if !strings.HasPrefix(req.Endpoint, "https://") || req.Keys.P256dh == "" || req.Keys.Auth == "" {
		writeErr(w, http.StatusBadRequest, "invalid subscription")
		return
	}
	if err := s.st.AddPushSubscription(r.Context(), u.ID, req.Endpoint, req.Keys.P256dh, req.Keys.Auth); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save subscription")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handlePushUnsubscribe removes a push subscription by endpoint (called when the
// user turns notifications off or the browser rotates the subscription).
func (s *Server) handlePushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Endpoint string `json:"endpoint"`
	}
	if err := readJSON(r, &req); err != nil || req.Endpoint == "" {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := s.st.DeletePushSubscriptionByEndpoint(r.Context(), req.Endpoint); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not remove subscription")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
