// Trailing-whitespace trim for outgoing message content.
//
// SOURCE OF TRUTH is the server: internal/httpapi/handlers_messages.go does
//   req.Content = strings.TrimRight(req.Content, " \t\r\n")
// before persisting. The client MUST trim identically before it (a) sends and
// (b) paints the optimistic row, because reconcileOptimistic matches the
// echoed message.new to its pending row by EXACT content (the server
// round-trips no client nonce). Any drift — a stray trailing space or newline
// the client keeps but the server strips — orphans the dimmed optimistic row:
// the echo can't find it, so the real message appends while the pending row is
// left stuck forever (a visible duplicate on send).
//
// Keep this regex in lockstep with the Go cutset " \t\r\n" (right side only).
// web/test/trim.test.js pins the parity.
export const trimMessageContent = (s) => s.replace(/[ \t\r\n]+$/, "");
