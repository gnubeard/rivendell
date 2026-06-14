package httpapi

import (
	"context"
	"log"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"rivendell/internal/auth"
	"rivendell/internal/store"
)

// --- middleware ----------------------------------------------------------

func (s *Server) recoverMW(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("panic: %v\n%s", rec, debug.Stack())
				writeErr(w, http.StatusInternalServerError, "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(c int) { r.status = c; r.ResponseWriter.WriteHeader(c) }

func (s *Server) logMW(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		// Don't wrap the writer for websocket upgrades (need the Hijacker).
		if r.URL.Path == "/api/ws" {
			next.ServeHTTP(w, r)
			return
		}
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
}

// --- auth context --------------------------------------------------------

type ctxKey int

const userKey ctxKey = 0

func userFrom(ctx context.Context) store.User {
	u, _ := ctx.Value(userKey).(store.User)
	return u
}

// auth wraps a handler requiring a valid session.
func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := s.currentUser(r)
		if !ok {
			writeErr(w, http.StatusUnauthorized, "not authenticated")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), userKey, u)))
	}
}

// requireRole wraps a handler requiring at least the given role
// (admin > moderator > member).
func (s *Server) requireRole(min store.Role, next http.HandlerFunc) http.HandlerFunc {
	return s.auth(func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if roleRank(u.Role) < roleRank(min) {
			writeErr(w, http.StatusForbidden, "insufficient privileges")
			return
		}
		next(w, r)
	})
}

func roleRank(r store.Role) int {
	switch r {
	case store.RoleAdmin:
		return 3
	case store.RoleModerator:
		return 2
	default:
		return 1
	}
}

func (s *Server) currentUser(r *http.Request) (store.User, bool) {
	// Session cookie (browser / normal login).
	if c, err := r.Cookie(sessionCookie); err == nil && c.Value != "" {
		if u, err := s.st.UserForSession(r.Context(), auth.HashToken(c.Value)); err == nil {
			return u, true
		}
	}
	// Bearer token (bot / API access; no cookie, no redirect).
	if hdr := r.Header.Get("Authorization"); strings.HasPrefix(hdr, "Bearer ") {
		if token := strings.TrimPrefix(hdr, "Bearer "); token != "" {
			if u, err := s.st.UserForBotToken(r.Context(), auth.HashToken(token)); err == nil {
				return u, true
			}
		}
	}
	return store.User{}, false
}

func (s *Server) setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.cfg.Secure,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Now().Add(s.cfg.SessionTTL),
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/",
		HttpOnly: true, Secure: s.cfg.Secure, SameSite: http.SameSiteLaxMode,
		MaxAge: -1,
	})
}
