package httpapi

import (
	"os"
	"testing"

	"rivendell/internal/auth"
)

// TestMain lowers the PBKDF2 work factor for this package's tests. The handler
// tests seed ~100 users via real login flows; at the production 600k iterations
// each hash+verify is ~100ms, which dominated the suite's runtime. The hash
// format is self-describing (Verify reads the iteration count from the stored
// hash), so seeding at 1 iteration still exercises the genuine login path. The
// production default stays 600k and is guarded by
// auth.TestDefaultIterationsIsProductionGrade.
func TestMain(m *testing.M) {
	auth.DefaultIterations = 1
	os.Exit(m.Run())
}
