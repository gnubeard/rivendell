package ws

import (
	"bytes"
	"testing"
)

// RFC 6455 §1.3 worked example.
func TestAcceptKey(t *testing.T) {
	got := acceptKey("dGhlIHNhbXBsZSBub25jZQ==")
	want := "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
	if got != want {
		t.Fatalf("acceptKey = %q, want %q", got, want)
	}
}

// RFC 6455 §5.7: a single-frame masked "Hello".
func TestReadFrame_MaskedHello(t *testing.T) {
	raw := []byte{0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58}
	f, err := readFrame(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if !f.fin || f.opcode != opText {
		t.Fatalf("fin=%v opcode=%x", f.fin, f.opcode)
	}
	if string(f.payload) != "Hello" {
		t.Fatalf("payload = %q, want Hello", f.payload)
	}
}

// RFC 6455 §5.7: a single-frame unmasked "Hello" is what the server writes.
func TestWriteFrame_UnmaskedHello(t *testing.T) {
	var buf bytes.Buffer
	if err := writeFrame(&buf, true, opText, []byte("Hello")); err != nil {
		t.Fatal(err)
	}
	want := []byte{0x81, 0x05, 'H', 'e', 'l', 'l', 'o'}
	if !bytes.Equal(buf.Bytes(), want) {
		t.Fatalf("frame = % x, want % x", buf.Bytes(), want)
	}
}

func TestFrameRoundTrip_ExtendedLengths(t *testing.T) {
	for _, size := range []int{0, 1, 125, 126, 200, 65535, 65536, 70000} {
		payload := bytes.Repeat([]byte{'x'}, size)
		var buf bytes.Buffer
		if err := writeFrame(&buf, true, opBinary, payload); err != nil {
			t.Fatalf("write size %d: %v", size, err)
		}
		f, err := readFrame(&buf)
		if err != nil {
			t.Fatalf("read size %d: %v", size, err)
		}
		if !bytes.Equal(f.payload, payload) {
			t.Fatalf("round-trip mismatch at size %d", size)
		}
	}
}

func TestReadFrame_RejectsOversize(t *testing.T) {
	// length field claims 127 (8-byte length) with a huge value.
	raw := []byte{0x82, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}
	if _, err := readFrame(bytes.NewReader(raw)); err == nil {
		t.Fatal("expected oversize frame to be rejected")
	}
}
