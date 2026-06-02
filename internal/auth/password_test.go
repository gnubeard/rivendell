package auth

import (
	"encoding/hex"
	"testing"
)

// RFC 6070 publishes PBKDF2-HMAC-SHA1 vectors. RFC 7914 / common references
// publish PBKDF2-HMAC-SHA256 vectors; we use the widely-cited ones below to
// prove our SHA-256 implementation is correct.
func TestPBKDF2_SHA256_KnownVectors(t *testing.T) {
	cases := []struct {
		pass, salt string
		iter, dk   int
		want       string
	}{
		{"password", "salt", 1, 32, "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"},
		{"password", "salt", 2, 32, "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43"},
		{"password", "salt", 4096, 32, "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"},
		{"passwordPASSWORDpassword", "saltSALTsaltSALTsaltSALTsaltSALTsalt", 4096, 40,
			"348c89dbcbd32b2f32d814b8116e84cf2b17347ebc1800181c4e2a1fb8dd53e1c635518c7dac47e9"},
	}
	for _, c := range cases {
		got := pbkdf2SHA256([]byte(c.pass), []byte(c.salt), c.iter, c.dk)
		if hex.EncodeToString(got) != c.want {
			t.Errorf("pbkdf2(%q,%q,%d,%d)=%x want %s", c.pass, c.salt, c.iter, c.dk, got, c.want)
		}
	}
}

func TestHashVerifyRoundTrip(t *testing.T) {
	// Use a small iteration count via encodeHash to keep the test fast.
	h := encodeHash("correct horse battery staple", []byte("0123456789abcdef"), 1000)
	if err := VerifyPassword(h, "correct horse battery staple"); err != nil {
		t.Fatalf("verify good password: %v", err)
	}
	if err := VerifyPassword(h, "Tr0ub4dour"); err != ErrMismatch {
		t.Fatalf("verify bad password: got %v want ErrMismatch", err)
	}
}

func TestHashPasswordProducesVerifiableHash(t *testing.T) {
	h, err := HashPassword("hunter2")
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyPassword(h, "hunter2"); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if err := VerifyPassword(h, "hunter3"); err == nil {
		t.Fatal("expected mismatch for wrong password")
	}
}

func TestVerifyRejectsMalformed(t *testing.T) {
	for _, bad := range []string{"", "x", "pbkdf2-sha256$abc$x$y", "md5$1$a$b"} {
		if err := VerifyPassword(bad, "p"); err == nil {
			t.Errorf("expected error for %q", bad)
		}
	}
}

func TestNewTokenUniqueAndStable(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		tok, err := NewToken()
		if err != nil {
			t.Fatal(err)
		}
		if seen[tok] {
			t.Fatal("duplicate token generated")
		}
		seen[tok] = true
		if HashToken(tok) != HashToken(tok) {
			t.Fatal("HashToken not deterministic")
		}
	}
}
