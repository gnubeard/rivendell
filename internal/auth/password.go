// Package auth provides password hashing and secure token handling using only
// the Go standard library. We deliberately avoid third-party crypto.
//
// Passwords are hashed with PBKDF2-HMAC-SHA256. PBKDF2 is implemented here in a
// few lines on top of crypto/hmac + crypto/sha256 (RFC 8018), and verified
// against the RFC 6070 test vectors in password_test.go. Argon2id would be a
// reasonable future upgrade, but it is not in the standard library; PBKDF2 with
// a high iteration count is a defensible, audited, FIPS-approved choice and
// keeps the dependency footprint at zero.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// DefaultIterations follows OWASP guidance for PBKDF2-HMAC-SHA256 (2023). It is
// a var, not a const, solely so tests can lower the cost (one 600k-iteration
// hash is ~100ms by design); production MUST keep the 600k default. Verify reads
// the iteration count from the self-describing hash, so a hash produced at a
// lowered count still verifies. TestDefaultIterationsIsProductionGrade guards the
// default from accidental downgrade.
var DefaultIterations = 600_000

const (
	saltLen = 16
	keyLen  = 32
)

// ErrMismatch is returned when a password does not match a stored hash.
var ErrMismatch = errors.New("auth: password does not match")

// pbkdf2SHA256 derives a key of length keyLen using PBKDF2-HMAC-SHA256.
// Implemented per RFC 8018 §5.2. Kept tiny and self-contained on purpose.
func pbkdf2SHA256(password, salt []byte, iter, keyLen int) []byte {
	prf := hmac.New(sha256.New, password)
	hLen := prf.Size()
	numBlocks := (keyLen + hLen - 1) / hLen
	out := make([]byte, 0, numBlocks*hLen)
	block := make([]byte, 4)
	u := make([]byte, hLen)
	t := make([]byte, hLen)
	for i := 1; i <= numBlocks; i++ {
		block[0] = byte(i >> 24)
		block[1] = byte(i >> 16)
		block[2] = byte(i >> 8)
		block[3] = byte(i)
		prf.Reset()
		prf.Write(salt)
		prf.Write(block)
		u = prf.Sum(u[:0])
		copy(t, u)
		for n := 2; n <= iter; n++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(u[:0])
			for j := range t {
				t[j] ^= u[j]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}

// HashPassword returns an encoded hash string of the form:
//
//	pbkdf2-sha256$<iter>$<b64salt>$<b64key>
//
// The format is self-describing so iteration counts can be raised over time
// without breaking existing hashes.
func HashPassword(password string) (string, error) {
	if password == "" {
		return "", errors.New("auth: empty password")
	}
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("auth: read salt: %w", err)
	}
	return encodeHash(password, salt, DefaultIterations), nil
}

func encodeHash(password string, salt []byte, iter int) string {
	dk := pbkdf2SHA256([]byte(password), salt, iter, keyLen)
	b64 := base64.RawStdEncoding.EncodeToString
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", iter, b64(salt), b64(dk))
}

// VerifyPassword checks password against an encoded hash in constant time.
func VerifyPassword(encoded, password string) error {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return errors.New("auth: malformed hash")
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter < 1 {
		return errors.New("auth: bad iteration count")
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil {
		return errors.New("auth: bad salt encoding")
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return errors.New("auth: bad key encoding")
	}
	got := pbkdf2SHA256([]byte(password), salt, iter, len(want))
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return ErrMismatch
	}
	return nil
}
