package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
)

// NewToken returns a URL-safe random token with 256 bits of entropy. It is
// shown to a user exactly once (in a cookie or a magic link). We never store
// the token itself; we store HashToken(token).
func NewToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("auth: read random: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// HashToken returns a hex SHA-256 of a token, suitable for a UNIQUE column.
// Tokens are high-entropy random values, so a fast hash is appropriate here
// (unlike passwords); this lets us look them up by an indexed equality check
// without keeping the plaintext anywhere on the server.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
