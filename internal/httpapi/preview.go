package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"syscall"
	"time"

	"rivendell/internal/store"
)

var (
	// metaTagRE matches a single <meta ...> tag. [^>]* stops at the first >,
	// which is safe because og: content values on real sites are HTML-entity-
	// encoded and won't contain a raw >.
	metaTagRE = regexp.MustCompile(`(?i)<meta\b[^>]+>`)
	// attrRE extracts key="value" or key='value' attribute pairs.
	attrRE = regexp.MustCompile(`(?i)([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')`)
)

// isPublicIP reports whether ip is a routable public address. The link-preview
// fetcher refuses everything else — loopback, RFC1918/ULA private, link-local
// (including the 169.254.169.254 cloud-metadata endpoint), unspecified, and
// multicast — so an allowlisted host that redirects or resolves to an internal
// address cannot be used to reach the server's own network. See the SSRF note
// in CLAUDE.md.
func isPublicIP(ip net.IP) bool {
	return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast())
}

// checkPreviewRedirect builds a CheckRedirect policy that keeps the fetcher on
// https and on allowlisted hosts for EVERY hop, not just the first. The entry
// handler allowlists the initial URL, but an open redirect on an allowlisted
// host would otherwise bounce the fetch to an arbitrary destination.
func checkPreviewRedirect(allowed func(hostname string) bool) func(*http.Request, []*http.Request) error {
	return func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("too many redirects")
		}
		if req.URL.Scheme != "https" {
			return fmt.Errorf("redirect to non-https %q", req.URL.Scheme)
		}
		if !allowed(req.URL.Hostname()) {
			return fmt.Errorf("redirect to non-allowlisted host %q", req.URL.Hostname())
		}
		return nil
	}
}

// newPreviewClient builds the outbound client for link-preview fetches with two
// SSRF guards: a dial Control hook that refuses non-public IPs (catching DNS
// rebinding and redirects to internal addresses at connect time, before TLS),
// and a CheckRedirect policy that re-applies the https + allowlist checks on
// every hop.
func newPreviewClient(allowed func(hostname string) bool) *http.Client {
	dialer := &net.Dialer{
		Timeout:   8 * time.Second,
		KeepAlive: 30 * time.Second,
		// Control runs after DNS resolution with the concrete IP that will be
		// dialed, so vetting here is immune to rebinding between resolve and connect.
		Control: func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			ip := net.ParseIP(host)
			if ip == nil || !isPublicIP(ip) {
				return fmt.Errorf("refusing to dial non-public address %s", address)
			}
			return nil
		},
	}
	return &http.Client{
		Transport: &http.Transport{
			DialContext:           dialer.DialContext,
			TLSHandshakeTimeout:   5 * time.Second,
			ResponseHeaderTimeout: 8 * time.Second,
		},
		CheckRedirect: checkPreviewRedirect(allowed),
	}
}

// fetchOGTags fetches rawURL and extracts og: meta-tag values. ExpiresAt is
// intentionally left zero — the caller sets it based on success or failure.
func fetchOGTags(ctx context.Context, client *http.Client, rawURL string) (store.LinkPreview, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
	if err != nil {
		return store.LinkPreview{}, err
	}
	req.Header.Set("User-Agent", "rivendell/1.0 (+link-preview-bot)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")

	resp, err := client.Do(req)
	if err != nil {
		return store.LinkPreview{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return store.LinkPreview{}, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	if !strings.Contains(ct, "html") {
		return store.LinkPreview{URL: rawURL}, nil
	}

	// Read up to 512 KB, stopping after </head> to avoid large bodies.
	buf := &bytes.Buffer{}
	lr := io.LimitReader(resp.Body, 512*1024)
	chunk := make([]byte, 4096)
	for {
		n, readErr := lr.Read(chunk)
		if n > 0 {
			buf.Write(chunk[:n])
			if bytes.Contains(bytes.ToLower(buf.Bytes()), []byte("</head>")) {
				break
			}
		}
		if readErr != nil {
			break
		}
	}

	og := map[string]string{}
	for _, tag := range metaTagRE.FindAllString(buf.String(), -1) {
		attrs := parseAttrs(tag)
		prop := strings.ToLower(attrs["property"])
		if prop == "" {
			prop = strings.ToLower(attrs["name"])
		}
		content := attrs["content"]
		if content == "" {
			continue
		}
		switch prop {
		case "og:title":
			og["title"] = html.UnescapeString(content)
		case "og:description":
			og["description"] = html.UnescapeString(content)
		case "og:image":
			if og["image"] == "" {
				og["image"] = content
			}
		case "og:site_name":
			og["site_name"] = html.UnescapeString(content)
		case "description":
			if og["desc_fallback"] == "" {
				og["desc_fallback"] = html.UnescapeString(content)
			}
		}
	}

	lp := store.LinkPreview{URL: rawURL}
	lp.Title = og["title"]
	lp.Description = og["description"]
	if lp.Description == "" {
		lp.Description = og["desc_fallback"]
	}
	lp.SiteName = og["site_name"]

	if imgRaw := og["image"]; imgRaw != "" {
		if base, err := url.Parse(rawURL); err == nil {
			if imgRef, err := url.Parse(imgRaw); err == nil {
				resolved := base.ResolveReference(imgRef)
				if resolved.Scheme == "https" {
					lp.ImageURL = resolved.String()
				}
			}
		}
	}

	return lp, nil
}

// parseAttrs extracts key=value attribute pairs from a tag string.
func parseAttrs(tag string) map[string]string {
	attrs := make(map[string]string)
	for _, m := range attrRE.FindAllStringSubmatch(tag, -1) {
		key := strings.ToLower(m[1])
		val := m[2] // double-quoted
		if val == "" {
			val = m[3] // single-quoted
		}
		if _, exists := attrs[key]; !exists {
			attrs[key] = val
		}
	}
	return attrs
}

// domainAllowed reports whether hostname (e.g. "en.wikipedia.org") is on the
// configured allowlist. Matching is case-insensitive and covers subdomains.
func (s *Server) domainAllowed(hostname string) bool {
	hostname = strings.ToLower(hostname)
	for _, d := range s.cfg.LinkPreviewDomains {
		d = strings.ToLower(d)
		if hostname == d || strings.HasSuffix(hostname, "."+d) {
			return true
		}
	}
	return false
}

// fetchWikipediaSummary calls the Wikipedia REST summary API for a /wiki/ URL.
// It is invoked by fetchPreview and must not be called for non-Wikipedia URLs.
func fetchWikipediaSummary(ctx context.Context, client *http.Client, rawURL string, u *url.URL) (store.LinkPreview, error) {
	title := strings.TrimPrefix(u.Path, "/wiki/")
	apiURL := "https://" + u.Host + "/api/rest_v1/page/summary/" + title

	req, err := http.NewRequestWithContext(ctx, "GET", apiURL, nil)
	if err != nil {
		return store.LinkPreview{}, err
	}
	req.Header.Set("User-Agent", "rivendell/1.0 (+link-preview-bot)")
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return store.LinkPreview{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return store.LinkPreview{}, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	var data struct {
		Title     string `json:"title"`
		Extract   string `json:"extract"`
		Thumbnail struct {
			Source string `json:"source"`
		} `json:"thumbnail"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&data); err != nil {
		return store.LinkPreview{}, err
	}

	lp := store.LinkPreview{
		URL:         rawURL,
		Title:       data.Title,
		Description: data.Extract,
		SiteName:    "Wikipedia",
		ImageURL:    data.Thumbnail.Source,
	}
	return lp, nil
}

// fetchPreview fetches a link preview for rawURL. Wikipedia article URLs use
// the Wikipedia REST summary API; all other URLs use og: tag scraping.
func fetchPreview(ctx context.Context, client *http.Client, rawURL string) (store.LinkPreview, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return store.LinkPreview{}, err
	}
	if strings.HasSuffix(strings.ToLower(u.Hostname()), ".wikipedia.org") &&
		strings.HasPrefix(u.Path, "/wiki/") && len(u.Path) > len("/wiki/") {
		return fetchWikipediaSummary(ctx, client, rawURL, u)
	}
	return fetchOGTags(ctx, client, rawURL)
}

// fetchAndCache fetches og: tags for rawURL and saves the result. It uses
// s.inFlight to deduplicate concurrent requests for the same URL.
func (s *Server) fetchAndCache(rawURL string) {
	if _, loaded := s.inFlight.LoadOrStore(rawURL, struct{}{}); loaded {
		return
	}
	defer s.inFlight.Delete(rawURL)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	lp, err := fetchPreview(ctx, s.previewClient, rawURL)
	if err != nil {
		lp = store.LinkPreview{
			URL:       rawURL,
			ErrorMsg:  err.Error(),
			ExpiresAt: time.Now().Add(6 * time.Hour),
		}
	} else {
		lp.ExpiresAt = time.Now().Add(7 * 24 * time.Hour)
	}
	if saveErr := s.st.SaveLinkPreview(context.Background(), lp); saveErr != nil {
		log.Printf("link preview save %s: %v", rawURL, saveErr)
	}
}

// handleGetLinkPreview serves GET /api/link-preview?url=<url>.
// Returns 200 + JSON on cache hit, 202 on cache miss (background fetch
// started), or 404 when the domain is not allowlisted or a cached error exists.
func (s *Server) handleGetLinkPreview(w http.ResponseWriter, r *http.Request) {
	if len(s.cfg.LinkPreviewDomains) == 0 {
		http.NotFound(w, r)
		return
	}

	rawURL := strings.TrimSpace(r.URL.Query().Get("url"))
	if rawURL == "" {
		writeErr(w, http.StatusBadRequest, "url parameter required")
		return
	}

	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		writeErr(w, http.StatusBadRequest, "invalid url")
		return
	}

	if !s.domainAllowed(parsed.Hostname()) {
		http.NotFound(w, r)
		return
	}

	lp, err := s.st.GetLinkPreview(r.Context(), rawURL)
	if err == nil {
		if lp.ErrorMsg != "" {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusOK, lp)
		return
	}
	if !errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusInternalServerError, "could not fetch preview")
		return
	}

	go s.fetchAndCache(rawURL)
	w.WriteHeader(http.StatusAccepted)
}
