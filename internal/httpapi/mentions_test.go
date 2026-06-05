package httpapi

import (
	"reflect"
	"testing"
)

// TestParseMentions pins the server-side mention parser to the same behaviour as
// MENTION_RE in web/static/format.js: boundary-aware, case-folded, 2–32 chars,
// and not tripped by emails or URL paths.
func TestParseMentions(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"no mentions here", nil},
		{"hey @alice and @bob", []string{"alice", "bob"}},
		{"@alice at the start", []string{"alice"}},
		{"shout @Alice loudly", []string{"alice"}}, // case-folded
		{"dupes @bob @bob @bob", []string{"bob"}},  // de-duplicated
		{"email foo@bar.com", nil},                 // @ preceded by a word char
		{"a path/@alice link", nil},                // @ preceded by '/'
		{"too short @a here", nil},                 // 1-char name rejected
		{"@ab is the min", []string{"ab"}},         // 2-char name ok
		{"@alice@bob adjacent", []string{"alice"}}, // second @ has no boundary
		{"punctuated @carol!", []string{"carol"}},
	}
	for _, c := range cases {
		got := parseMentions(c.in)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("parseMentions(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}
