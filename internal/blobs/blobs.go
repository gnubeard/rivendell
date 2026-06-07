// Package blobs implements content-addressed blob storage. The only concrete
// implementation is FSStore, which writes to a local directory tree structured
// as blobs/<2-hex-prefix>/<sha256-hex>. Content-addressing buys automatic dedup,
// immutable blobs (safe for long-lived CDN/browser caching), and path-traversal
// immunity (filenames are hashes, never user input).
package blobs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// BlobStore is the storage interface; FSStore is the only implementation for now.
type BlobStore interface {
	Put(ctx context.Context, r io.Reader) (hash string, size int64, err error)
	Open(ctx context.Context, hash string) (io.ReadCloser, error)
	Exists(ctx context.Context, hash string) (bool, error)
}

// FSStore stores blobs in a local directory as blobs/<2-hex>/<sha256>.
type FSStore struct {
	dir string
}

// NewFSStore opens (and creates if necessary) a blob store rooted at dir.
func NewFSStore(dir string) (*FSStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("blobs: create dir %s: %w", dir, err)
	}
	return &FSStore{dir: dir}, nil
}

func (s *FSStore) blobPath(hash string) string {
	return filepath.Join(s.dir, hash[:2], hash)
}

// Put reads all of r, hashes with SHA-256, and writes to the store. If the blob
// already exists (same hash), the write is a no-op. Returns the hex hash and byte
// count. The caller must have already bounded r with http.MaxBytesReader or similar.
func (s *FSStore) Put(_ context.Context, r io.Reader) (string, int64, error) {
	h := sha256.New()
	var buf bytes.Buffer
	n, err := io.Copy(&buf, io.TeeReader(r, h))
	if err != nil {
		return "", 0, fmt.Errorf("blobs: read: %w", err)
	}
	hash := hex.EncodeToString(h.Sum(nil))
	path := s.blobPath(hash)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", 0, fmt.Errorf("blobs: mkdir: %w", err)
	}
	// Atomic write: tmp then rename, so a concurrent reader never sees a partial file.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o644); err != nil {
		return "", 0, fmt.Errorf("blobs: write: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return "", 0, fmt.Errorf("blobs: rename: %w", err)
	}
	return hash, n, nil
}

// Open returns a ReadCloser for the blob with the given hash.
func (s *FSStore) Open(_ context.Context, hash string) (io.ReadCloser, error) {
	return os.Open(s.blobPath(hash))
}

// Exists reports whether the blob with the given hash is stored.
func (s *FSStore) Exists(_ context.Context, hash string) (bool, error) {
	_, err := os.Stat(s.blobPath(hash))
	if os.IsNotExist(err) {
		return false, nil
	}
	return err == nil, err
}
