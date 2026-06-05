package httpapi

import (
	"regexp"
	"strings"
)

// mentionRe matches an @username token that isn't part of an email/URL: the @
// must be at the start or follow a non-word, non-slash character. This MUST stay
// in lockstep with MENTION_RE in web/static/format.js so the server and client
// agree on what counts as a mention. Usernames are [A-Za-z0-9_]{2,32}; case is
// ignored and normalized to lower for comparison against stored usernames.
var mentionRe = regexp.MustCompile(`(^|[^A-Za-z0-9_/])@([A-Za-z0-9_]{2,32})`)

// parseMentions returns the distinct, lower-cased usernames @-mentioned in
// content, in first-seen order. The Go regexp engine doesn't rescan from inside
// a previous match, so adjacent mentions separated by a single delimiter are all
// found via the leading delimiter capture group.
func parseMentions(content string) []string {
	if content == "" {
		return nil
	}
	matches := mentionRe.FindAllStringSubmatch(content, -1)
	if matches == nil {
		return nil
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		name := strings.ToLower(m[2])
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	return out
}
