package push

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"math/big"
	"strings"
	"testing"
	"time"
)

// decryptPayload is the receiver (browser) side of RFC 8291: it reverses
// encryptPayload using the UA's private key. Test-only; proves the server's
// derivation matches what a real user agent computes.
func decryptPayload(body []byte, uaPriv *ecdh.PrivateKey) ([]byte, error) {
	salt := body[:16]
	idlen := int(body[20])
	asPublic := body[21 : 21+idlen]
	ciphertext := body[21+idlen:]

	asPub, err := ecdh.P256().NewPublicKey(asPublic)
	if err != nil {
		return nil, err
	}
	ecdhSecret, err := uaPriv.ECDH(asPub)
	if err != nil {
		return nil, err
	}
	uaPublic := uaPriv.PublicKey().Bytes()

	keyInfo := append([]byte("WebPush: info\x00"), uaPublic...)
	keyInfo = append(keyInfo, asPublic...)
	authSecret := testAuthSecret // closed over by the test below
	prkCombine, _ := hkdf.Extract(sha256.New, ecdhSecret, authSecret)
	ikm, _ := hkdf.Expand(sha256.New, prkCombine, string(keyInfo), 32)
	prk, _ := hkdf.Extract(sha256.New, ikm, salt)
	cek, _ := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	nonce, _ := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)

	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, err
	}
	// Strip the RFC 8188 last-record delimiter (0x02) and any padding.
	for i := len(plaintext) - 1; i >= 0; i-- {
		if plaintext[i] == 0x00 {
			continue
		}
		if plaintext[i] == 0x02 {
			return plaintext[:i], nil
		}
		break
	}
	return plaintext, nil
}

var testAuthSecret []byte

// TestEncryptRoundTrip is the core correctness guard: a payload encrypted by the
// server decrypts back to the same bytes on the receiver side, using the exact
// RFC 8291 derivation. If the key_info order, HKDF chain, or framing drift, this
// fails.
func TestEncryptRoundTrip(t *testing.T) {
	uaPriv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	authSecret := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, authSecret); err != nil {
		t.Fatal(err)
	}
	testAuthSecret = authSecret

	asPriv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	salt := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		t.Fatal(err)
	}

	plaintext := []byte(`{"title":"Elrond","body":"the council convenes","channelId":7}`)
	body, err := encryptPayload(plaintext, uaPriv.PublicKey().Bytes(), authSecret, asPriv, salt)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	// Structural checks on the aes128gcm content-coding header.
	if got := body[:16]; string(got) != string(salt) {
		t.Errorf("header salt mismatch")
	}
	if rs := binary.BigEndian.Uint32(body[16:20]); rs != recordSize {
		t.Errorf("record size = %d, want %d", rs, recordSize)
	}
	if idlen := int(body[20]); idlen != 65 {
		t.Errorf("keyid length = %d, want 65", idlen)
	}
	if keyid := body[21:86]; string(keyid) != string(asPriv.PublicKey().Bytes()) {
		t.Errorf("keyid is not the sender's public point")
	}

	got, err := decryptPayload(body, uaPriv)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if string(got) != string(plaintext) {
		t.Errorf("round-trip mismatch:\n got: %q\nwant: %q", got, plaintext)
	}
}

// TestEncryptWrongKeyFails confirms the AEAD actually authenticates: a different
// UA keypair can't decrypt a message sealed for the original subscription.
func TestEncryptWrongKeyFails(t *testing.T) {
	uaPriv, _ := ecdh.P256().GenerateKey(rand.Reader)
	authSecret := make([]byte, 16)
	io.ReadFull(rand.Reader, authSecret)
	testAuthSecret = authSecret
	asPriv, _ := ecdh.P256().GenerateKey(rand.Reader)
	salt := make([]byte, 16)
	io.ReadFull(rand.Reader, salt)

	body, err := encryptPayload([]byte("secret"), uaPriv.PublicKey().Bytes(), authSecret, asPriv, salt)
	if err != nil {
		t.Fatal(err)
	}
	other, _ := ecdh.P256().GenerateKey(rand.Reader)
	if _, err := decryptPayload(body, other); err == nil {
		t.Error("expected decryption with the wrong key to fail, but it succeeded")
	}
}

// TestVAPIDKeysRoundTrip generates a VAPID keypair, rebuilds a Sender from the
// stored private key, and checks the public key is a valid 65-byte point.
func TestVAPIDKeysRoundTrip(t *testing.T) {
	privB64, pubB64, err := GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewSender(privB64, "mailto:admin@example.com")
	if err != nil {
		t.Fatalf("NewSender: %v", err)
	}
	if s.PublicKey() != pubB64 {
		t.Errorf("Sender public key %q != generated %q", s.PublicKey(), pubB64)
	}
	pt, err := base64.RawURLEncoding.DecodeString(pubB64)
	if err != nil {
		t.Fatalf("public key not base64url: %v", err)
	}
	if len(pt) != 65 || pt[0] != 0x04 {
		t.Errorf("public key is not an uncompressed P-256 point (len=%d, prefix=0x%02x)", len(pt), pt[0])
	}
}

// TestVAPIDJWT builds a VAPID JWT and verifies it: structure, the JOSE raw r||s
// signature against the public key, and the claims.
func TestVAPIDJWT(t *testing.T) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	exp := time.Now().Add(time.Hour)
	tok, err := vapidJWT(priv, "https://fcm.googleapis.com", "mailto:a@b.c", exp)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("JWT has %d parts, want 3", len(parts))
	}

	// Signature must be exactly 64 bytes (raw r||s), not DER (~70, variable).
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatalf("signature not base64url: %v", err)
	}
	if len(sig) != 64 {
		t.Fatalf("signature is %d bytes, want 64 (raw r||s, not DER)", len(sig))
	}

	// Verify the signature over the signing input.
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	if !ecdsa.Verify(&priv.PublicKey, digest[:], r, s) {
		t.Error("VAPID JWT signature failed to verify against its public key")
	}

	// Claims round-trip.
	claimsJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims struct {
		Aud string `json:"aud"`
		Sub string `json:"sub"`
		Exp int64  `json:"exp"`
	}
	if err := json.Unmarshal(claimsJSON, &claims); err != nil {
		t.Fatal(err)
	}
	if claims.Aud != "https://fcm.googleapis.com" {
		t.Errorf("aud = %q", claims.Aud)
	}
	if claims.Sub != "mailto:a@b.c" {
		t.Errorf("sub = %q", claims.Sub)
	}
	if claims.Exp != exp.Unix() {
		t.Errorf("exp = %d, want %d", claims.Exp, exp.Unix())
	}
}

// TestVAPIDAuthHeaderAudience confirms the JWT audience is the endpoint's
// scheme://host (push services reject a mismatched aud).
func TestVAPIDAuthHeaderAudience(t *testing.T) {
	privB64, _, _ := GenerateVAPIDKeys()
	s, _ := NewSender(privB64, "mailto:a@b.c")
	hdr, err := s.vapidAuthHeader("https://updates.push.services.mozilla.com/wpush/v2/abc123")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hdr, "vapid t=") || !strings.Contains(hdr, ", k=") {
		t.Fatalf("malformed Authorization header: %q", hdr)
	}
	tok := strings.TrimPrefix(strings.SplitN(hdr, ", k=", 2)[0], "vapid t=")
	parts := strings.Split(tok, ".")
	claimsJSON, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var claims struct {
		Aud string `json:"aud"`
	}
	json.Unmarshal(claimsJSON, &claims)
	if claims.Aud != "https://updates.push.services.mozilla.com" {
		t.Errorf("aud = %q, want scheme://host only", claims.Aud)
	}
}

func TestDecodeB64URLPaddingTolerant(t *testing.T) {
	raw := []byte{0x01, 0x02, 0x03, 0x04, 0x05}
	padded := base64.URLEncoding.EncodeToString(raw)      // with '='
	unpadded := base64.RawURLEncoding.EncodeToString(raw) // without
	for _, in := range []string{padded, unpadded} {
		got, err := decodeB64URL(in)
		if err != nil {
			t.Fatalf("decode %q: %v", in, err)
		}
		if string(got) != string(raw) {
			t.Errorf("decode %q = %v, want %v", in, got, raw)
		}
	}
}
