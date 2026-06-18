// Package push implements Web Push (RFC 8030/8291/8292) message delivery using
// only the Go standard library — no third-party Web Push or JWT module,
// consistent with the repo's prime directive.
//
// Two distinct EC keys are involved and must not be conflated:
//
//   - The VAPID key (ECDSA P-256, long-lived, persisted): identifies this server
//     to the push service. Its public point is the browser's applicationServerKey
//     and the `k=` of the Authorization header. Used only to sign the VAPID JWT.
//   - The message ephemeral key (ECDH P-256, fresh per push): agreed against the
//     subscription's p256dh to derive the content-encryption key. Never stored.
//
// Payload encryption is RFC 8291 ("Message Encryption for Web Push") over the
// RFC 8188 `aes128gcm` content coding: ECDH → HKDF-SHA-256 → AES-128-GCM. See
// docs/design/web-push.md.
package push

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ErrSubscriptionGone is returned by Send when the push service reports the
// subscription no longer exists (404/410). The caller should delete it.
var ErrSubscriptionGone = errors.New("push: subscription gone")

// recordSize is the RFC 8188 record size advertised in the content-coding
// header. Our payloads are a single small record well under this.
const recordSize = 4096

// jwtTTL is how long a VAPID JWT stays valid. Push services cap this at 24h.
const jwtTTL = 12 * time.Hour

// pushTTL is the Time-To-Live (seconds) we ask the push service to retain an
// undelivered message — long enough to survive a sleeping device for a day.
const pushTTL = 24 * 60 * 60

// Subscription is a browser PushSubscription: where to send, and the keys used
// to encrypt the payload to it. p256dh and auth are base64url (RFC 8291).
type Subscription struct {
	Endpoint string
	P256dh   string
	Auth     string
}

// Sender holds the server's VAPID identity and an HTTP client. Safe for
// concurrent use.
type Sender struct {
	priv      *ecdsa.PrivateKey
	publicB64 string // applicationServerKey / `k=`, base64url uncompressed point
	subject   string // VAPID `sub` claim (mailto: or https URL)
	client    *http.Client
}

// GenerateVAPIDKeys mints a fresh VAPID keypair, returning the private key as
// base64 PKCS#8 (a server secret) and the public key as a base64url uncompressed
// P-256 point (the applicationServerKey). Persist both.
func GenerateVAPIDKeys() (privB64, pubB64 string, err error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", err
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return "", "", err
	}
	pub, err := publicPointB64(priv)
	if err != nil {
		return "", "", err
	}
	return base64.StdEncoding.EncodeToString(pkcs8), pub, nil
}

// NewSender builds a Sender from a base64 PKCS#8 private key (as produced by
// GenerateVAPIDKeys) and the VAPID subject (a mailto: or https URL the push
// service can use to contact the operator).
func NewSender(privB64, subject string) (*Sender, error) {
	raw, err := base64.StdEncoding.DecodeString(privB64)
	if err != nil {
		return nil, fmt.Errorf("push: decode private key: %w", err)
	}
	key, err := x509.ParsePKCS8PrivateKey(raw)
	if err != nil {
		return nil, fmt.Errorf("push: parse private key: %w", err)
	}
	priv, ok := key.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("push: VAPID key is not ECDSA")
	}
	pub, err := publicPointB64(priv)
	if err != nil {
		return nil, err
	}
	if subject == "" {
		subject = "mailto:admin@localhost"
	}
	return &Sender{
		priv:      priv,
		publicB64: pub,
		subject:   subject,
		client:    &http.Client{Timeout: 30 * time.Second},
	}, nil
}

// PublicKey returns the applicationServerKey (base64url uncompressed point) to
// hand to the browser for pushManager.subscribe.
func (s *Sender) PublicKey() string { return s.publicB64 }

// Send encrypts payload to the subscription and POSTs it to the push service.
// Returns ErrSubscriptionGone for a 404/410 (caller should delete the row),
// nil on 2xx, or an error otherwise.
func (s *Sender) Send(ctx context.Context, sub Subscription, payload []byte) error {
	uaPublic, err := decodeB64URL(sub.P256dh)
	if err != nil {
		return fmt.Errorf("push: bad p256dh: %w", err)
	}
	authSecret, err := decodeB64URL(sub.Auth)
	if err != nil {
		return fmt.Errorf("push: bad auth: %w", err)
	}
	asPriv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	salt := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return err
	}
	body, err := encryptPayload(payload, uaPublic, authSecret, asPriv, salt)
	if err != nil {
		return err
	}
	authHeader, err := s.vapidAuthHeader(sub.Endpoint)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sub.Endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("TTL", fmt.Sprintf("%d", pushTTL))
	req.Header.Set("Urgency", "high")
	req.Header.Set("Authorization", authHeader)

	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	switch {
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
		return ErrSubscriptionGone
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil
	default:
		return fmt.Errorf("push: %s returned %d", req.URL.Host, resp.StatusCode)
	}
}

// vapidAuthHeader builds the `vapid t=<JWT>, k=<pubkey>` Authorization header for
// a given endpoint. The JWT audience is the endpoint's scheme://host.
func (s *Sender) vapidAuthHeader(endpoint string) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", fmt.Errorf("push: bad endpoint: %w", err)
	}
	aud := u.Scheme + "://" + u.Host
	jwt, err := vapidJWT(s.priv, aud, s.subject, time.Now().Add(jwtTTL))
	if err != nil {
		return "", err
	}
	return "vapid t=" + jwt + ", k=" + s.publicB64, nil
}

// --- crypto (pure, deterministic given salt + ephemeral key) --------------

// encryptPayload performs RFC 8291 message encryption over the RFC 8188
// aes128gcm content coding, returning the full message body
// (header || ciphertext). asPriv and salt are parameters so the function is
// deterministic and unit-testable.
func encryptPayload(payload, uaPublic, authSecret []byte, asPriv *ecdh.PrivateKey, salt []byte) ([]byte, error) {
	uaPub, err := ecdh.P256().NewPublicKey(uaPublic)
	if err != nil {
		return nil, fmt.Errorf("push: bad UA public key: %w", err)
	}
	ecdhSecret, err := asPriv.ECDH(uaPub)
	if err != nil {
		return nil, fmt.Errorf("push: ECDH: %w", err)
	}
	asPublic := asPriv.PublicKey().Bytes() // 65-byte uncompressed point

	// RFC 8291 §3.4: fold the auth secret and both public keys into the IKM.
	keyInfo := append([]byte("WebPush: info\x00"), uaPublic...)
	keyInfo = append(keyInfo, asPublic...)
	prkCombine, err := hkdf.Extract(sha256.New, ecdhSecret, authSecret)
	if err != nil {
		return nil, err
	}
	ikm, err := hkdf.Expand(sha256.New, prkCombine, string(keyInfo), 32)
	if err != nil {
		return nil, err
	}

	// RFC 8188 §2.2: derive CEK + nonce from the message salt.
	prk, err := hkdf.Extract(sha256.New, ikm, salt)
	if err != nil {
		return nil, err
	}
	cek, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, err
	}
	nonce, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, err
	}

	// One record: plaintext, then the last-record delimiter 0x02 (no padding).
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plaintext := append(append([]byte{}, payload...), 0x02)
	ciphertext := gcm.Seal(nil, nonce, plaintext, nil)

	// RFC 8188 §2.1 content-coding header; keyid is the sender's public point.
	header := make([]byte, 0, 16+4+1+len(asPublic))
	header = append(header, salt...)
	header = binary.BigEndian.AppendUint32(header, recordSize)
	header = append(header, byte(len(asPublic)))
	header = append(header, asPublic...)
	return append(header, ciphertext...), nil
}

// --- VAPID JWT (ES256, JOSE raw r||s signature) ---------------------------

func vapidJWT(priv *ecdsa.PrivateKey, audience, subject string, exp time.Time) (string, error) {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`))
	claims, err := json.Marshal(map[string]any{
		"aud": audience,
		"exp": exp.Unix(),
		"sub": subject,
	})
	if err != nil {
		return "", err
	}
	signingInput := header + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(signingInput))
	r, sBig, err := ecdsa.Sign(rand.Reader, priv, digest[:])
	if err != nil {
		return "", err
	}
	// JOSE: fixed-width 32-byte r and s concatenated — NOT ASN.1 DER.
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	sBig.FillBytes(sig[32:])
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// --- helpers --------------------------------------------------------------

// publicPointB64 returns an ECDSA P-256 public key as a base64url uncompressed
// point (the applicationServerKey / VAPID `k=` form).
func publicPointB64(priv *ecdsa.PrivateKey) (string, error) {
	ecdhPub, err := priv.PublicKey.ECDH()
	if err != nil {
		return "", fmt.Errorf("push: convert public key: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(ecdhPub.Bytes()), nil
}

// decodeB64URL decodes base64url with or without padding (browsers omit it; some
// libraries include it).
func decodeB64URL(s string) ([]byte, error) {
	s = strings.TrimRight(s, "=")
	return base64.RawURLEncoding.DecodeString(s)
}
