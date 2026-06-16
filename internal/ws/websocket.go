// Package ws is a small, self-contained WebSocket (RFC 6455) server built on the
// standard library only — no third-party websocket dependency. It supports text
// frames, fragmentation/continuation, and the ping/pong/close control frames,
// which is everything rivendell's realtime layer needs. The low-level frame codec
// (readFrame/writeFrame, acceptKey) is pure and unit-tested against the
// examples published in RFC 6455.
package ws

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// Opcodes per RFC 6455 §5.2.
const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

// MaxMessageBytes caps a single (possibly fragmented) message.
const MaxMessageBytes = 1 << 20 // 1 MiB

var (
	ErrClosed       = errors.New("ws: connection closed")
	errBadHandshake = errors.New("ws: bad handshake")
)

// acceptKey computes the Sec-WebSocket-Accept response value for a given
// Sec-WebSocket-Key (RFC 6455 §1.3).
func acceptKey(key string) string {
	h := sha1.New()
	io.WriteString(h, key+wsGUID)
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

// Conn is a single WebSocket connection.
type Conn struct {
	netConn net.Conn
	br      *bufio.Reader
	bw      *bufio.Writer

	// readTimeout, when > 0, is the maximum a single frame read may block. It is
	// (re)armed before every frame read inside ReadMessage, so ANY inbound frame —
	// including ping/pong control frames the loop consumes silently — counts as
	// liveness. This makes the timeout a true "no traffic at all" deadline rather
	// than a "no data message" deadline (a quiet-but-alive peer that only auto-pings
	// would otherwise be falsely reaped). See SetReadTimeout.
	readTimeout time.Duration
}

// newConn wraps an established net.Conn. Used by Accept and by tests.
func newConn(nc net.Conn) *Conn {
	return &Conn{netConn: nc, br: bufio.NewReader(nc), bw: bufio.NewWriter(nc)}
}

// Accept upgrades an HTTP request to a WebSocket connection.
func Accept(w http.ResponseWriter, r *http.Request) (*Conn, error) {
	if !tokenHeaderContains(r.Header, "Connection", "upgrade") ||
		!strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return nil, errBadHandshake
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		return nil, errBadHandshake
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return nil, errBadHandshake
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("ws: response writer does not support hijacking")
	}
	netConn, brw, err := hj.Hijack()
	if err != nil {
		return nil, fmt.Errorf("ws: hijack: %w", err)
	}
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + acceptKey(key) + "\r\n\r\n"
	if _, err := io.WriteString(brw.Writer, resp); err != nil {
		netConn.Close()
		return nil, err
	}
	if err := brw.Writer.Flush(); err != nil {
		netConn.Close()
		return nil, err
	}
	return &Conn{netConn: netConn, br: brw.Reader, bw: brw.Writer}, nil
}

// frame is a single decoded WebSocket frame.
type frame struct {
	fin     bool
	opcode  byte
	payload []byte
}

// readFrame reads and unmasks a single frame from r.
func readFrame(r io.Reader) (frame, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return frame{}, err
	}
	f := frame{fin: hdr[0]&0x80 != 0, opcode: hdr[0] & 0x0f}
	masked := hdr[1]&0x80 != 0
	length := uint64(hdr[1] & 0x7f)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return frame{}, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return frame{}, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if length > MaxMessageBytes {
		return frame{}, fmt.Errorf("ws: frame too large (%d bytes)", length)
	}
	var maskKey [4]byte
	if masked {
		if _, err := io.ReadFull(r, maskKey[:]); err != nil {
			return frame{}, err
		}
	}
	f.payload = make([]byte, length)
	if _, err := io.ReadFull(r, f.payload); err != nil {
		return frame{}, err
	}
	if masked {
		for i := range f.payload {
			f.payload[i] ^= maskKey[i%4]
		}
	}
	return f, nil
}

// writeFrame writes a single server frame (server frames are never masked).
func writeFrame(w io.Writer, fin bool, opcode byte, payload []byte) error {
	var hdr []byte
	b0 := opcode
	if fin {
		b0 |= 0x80
	}
	hdr = append(hdr, b0)
	n := len(payload)
	switch {
	case n < 126:
		hdr = append(hdr, byte(n))
	case n < 1<<16:
		hdr = append(hdr, 126, byte(n>>8), byte(n))
	default:
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(n))
		hdr = append(hdr, 127)
		hdr = append(hdr, ext[:]...)
	}
	if _, err := w.Write(hdr); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

// ReadMessage reads a complete (de-fragmented) text or binary message. Control
// frames (ping/close) are handled transparently; pings are answered with pongs.
func (c *Conn) ReadMessage() (opcode byte, data []byte, err error) {
	var msg []byte
	var msgOp byte
	for {
		if c.readTimeout > 0 {
			// Re-arm before every frame so control frames count as liveness too.
			if err := c.netConn.SetReadDeadline(time.Now().Add(c.readTimeout)); err != nil {
				return 0, nil, err
			}
		}
		f, err := readFrame(c.br)
		if err != nil {
			return 0, nil, err
		}
		switch f.opcode {
		case opPing:
			if err := c.writeControl(opPong, f.payload); err != nil {
				return 0, nil, err
			}
			continue
		case opPong:
			continue
		case opClose:
			_ = c.writeControl(opClose, nil)
			return 0, nil, ErrClosed
		case opText, opBinary:
			msgOp = f.opcode
			msg = append(msg, f.payload...)
		case opContinuation:
			msg = append(msg, f.payload...)
		default:
			return 0, nil, fmt.Errorf("ws: unknown opcode 0x%x", f.opcode)
		}
		if len(msg) > MaxMessageBytes {
			return 0, nil, errors.New("ws: message too large")
		}
		if f.fin {
			return msgOp, msg, nil
		}
	}
}

// WriteText sends a text message as a single frame.
func (c *Conn) WriteText(data []byte) error {
	if err := writeFrame(c.bw, true, opText, data); err != nil {
		return err
	}
	return c.bw.Flush()
}

// Ping sends a ping control frame.
func (c *Conn) Ping() error { return c.writeControl(opPing, nil) }

func (c *Conn) writeControl(opcode byte, payload []byte) error {
	if err := writeFrame(c.bw, true, opcode, payload); err != nil {
		return err
	}
	return c.bw.Flush()
}

// SetReadDeadline bounds how long a read may block (used for ping timeouts).
func (c *Conn) SetReadDeadline(t time.Time) error { return c.netConn.SetReadDeadline(t) }

// SetReadTimeout configures an idle timeout that ReadMessage re-arms before every
// frame read, so any inbound frame (data OR ping/pong) keeps the connection alive.
// A non-positive d disables it. Prefer this over SetReadDeadline for liveness: the
// latter only fires relative to the start of a ReadMessage call and so silently
// swallowed control frames don't extend it.
func (c *Conn) SetReadTimeout(d time.Duration) { c.readTimeout = d }

// Close sends a close frame and closes the underlying connection.
func (c *Conn) Close() error {
	_ = c.writeControl(opClose, nil)
	return c.netConn.Close()
}

// tokenHeaderContains reports whether a comma-separated header contains token
// (case-insensitive) — needed because "Connection" may be "keep-alive, Upgrade".
func tokenHeaderContains(h http.Header, name, token string) bool {
	for _, v := range h[name] {
		for _, part := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}
