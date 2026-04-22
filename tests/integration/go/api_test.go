// Package api_test end-to-end-tests the SupraBench public HTTP API
// from Go. Mirrors the Go snippets in /docs/api/quickstart.html so
// the tests double as executable documentation.
//
// Run:
//
//	SUPRABENCH_API_BASE=https://<deployment>.convex.site \
//	SUPRABENCH_API_KEY=sb_live_xxxxxxxx \
//	go test ./...
package apitest

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// ─── test harness ──────────────────────────────────────────────

type env struct {
	base      string
	key       string
	exportKey string
}

func loadEnv(t *testing.T) env {
	t.Helper()
	base := strings.TrimRight(os.Getenv("SUPRABENCH_API_BASE"), "/")
	key := os.Getenv("SUPRABENCH_API_KEY")
	if base == "" || key == "" {
		t.Skip("SUPRABENCH_API_BASE and SUPRABENCH_API_KEY env vars are required")
	}
	ek := os.Getenv("SUPRABENCH_API_EXPORT_KEY")
	if ek == "" {
		ek = key
	}
	return env{base: base, key: key, exportKey: ek}
}

var httpClient = &http.Client{Timeout: 15 * time.Second}

func doReq(t *testing.T, method, u, token string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, u, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := httpClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, u, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res, b
}

// ─── /v1/models ────────────────────────────────────────────────

func TestListModelsOK(t *testing.T) {
	e := loadEnv(t)
	res, body := doReq(t, "GET", e.base+"/v1/models", e.key)
	if res.StatusCode != 200 {
		t.Fatalf("status=%d body=%s", res.StatusCode, body)
	}
	if !strings.Contains(res.Header.Get("content-type"), "application/json") {
		t.Fatalf("content-type=%q", res.Header.Get("content-type"))
	}
	var arr []map[string]any
	if err := json.Unmarshal(body, &arr); err != nil {
		t.Fatalf("not a JSON array: %v", err)
	}
	if len(arr) > 0 {
		for _, f := range []string{"slug", "name", "provider", "supraScore", "tags"} {
			if _, ok := arr[0][f]; !ok {
				t.Fatalf("model missing field %q: %v", f, arr[0])
			}
		}
	}
}

func TestListModelsLimitClamp(t *testing.T) {
	e := loadEnv(t)
	res, body := doReq(t, "GET", e.base+"/v1/models?limit=10000", e.key)
	if res.StatusCode != 200 {
		t.Fatalf("status=%d", res.StatusCode)
	}
	var arr []any
	_ = json.Unmarshal(body, &arr)
	if len(arr) > 500 {
		t.Fatalf("limit not clamped: got %d", len(arr))
	}
}

func TestListModelsUnknownTagIsEmpty(t *testing.T) {
	e := loadEnv(t)
	q := url.Values{}
	q.Set("tag", "zzz-no-such-tag-zzz")
	res, body := doReq(t, "GET", e.base+"/v1/models?"+q.Encode(), e.key)
	if res.StatusCode != 200 {
		t.Fatalf("status=%d", res.StatusCode)
	}
	if strings.TrimSpace(string(body)) != "[]" {
		var arr []any
		_ = json.Unmarshal(body, &arr)
		if len(arr) != 0 {
			t.Fatalf("expected empty array, got %s", body)
		}
	}
}

// ─── /v1/models/{slug} ─────────────────────────────────────────

func TestModelDetailUnknownSlug(t *testing.T) {
	e := loadEnv(t)
	res, body := doReq(t, "GET", e.base+"/v1/models/nope-nope-nope", e.key)
	if res.StatusCode != 404 {
		t.Fatalf("status=%d body=%s", res.StatusCode, body)
	}
	var errEnv struct {
		Error struct{ Code string } `json:"error"`
	}
	_ = json.Unmarshal(body, &errEnv)
	if errEnv.Error.Code != "not_found" {
		t.Fatalf("error.code=%q", errEnv.Error.Code)
	}
}

func TestModelDetailOK(t *testing.T) {
	e := loadEnv(t)
	// Grab first slug from listing.
	res, body := doReq(t, "GET", e.base+"/v1/models?limit=1", e.key)
	if res.StatusCode != 200 {
		t.Fatalf("listing status=%d", res.StatusCode)
	}
	var arr []map[string]any
	_ = json.Unmarshal(body, &arr)
	if len(arr) == 0 {
		t.Skip("no models ranked yet")
	}
	slug, _ := arr[0]["slug"].(string)
	res, body = doReq(t, "GET", e.base+"/v1/models/"+slug, e.key)
	if res.StatusCode != 200 {
		t.Fatalf("detail status=%d body=%s", res.StatusCode, body)
	}
}

// ─── /v1/benches, /v1/tags ─────────────────────────────────────

func TestListBenchesOK(t *testing.T) {
	e := loadEnv(t)
	res, _ := doReq(t, "GET", e.base+"/v1/benches", e.key)
	if res.StatusCode != 200 {
		t.Fatalf("status=%d", res.StatusCode)
	}
}

func TestListTagsOK(t *testing.T) {
	e := loadEnv(t)
	res, _ := doReq(t, "GET", e.base+"/v1/tags", e.key)
	if res.StatusCode != 200 {
		t.Fatalf("status=%d", res.StatusCode)
	}
}

// ─── /v1/best ──────────────────────────────────────────────────

func TestBestRequiresTag(t *testing.T) {
	e := loadEnv(t)
	res, body := doReq(t, "GET", e.base+"/v1/best", e.key)
	if res.StatusCode != 400 {
		t.Fatalf("status=%d body=%s", res.StatusCode, body)
	}
	var errEnv struct {
		Error struct{ Code string } `json:"error"`
	}
	_ = json.Unmarshal(body, &errEnv)
	if errEnv.Error.Code != "bad_request" {
		t.Fatalf("error.code=%q", errEnv.Error.Code)
	}
}

func TestBestWithTagOK(t *testing.T) {
	e := loadEnv(t)
	res, _ := doReq(t, "GET", e.base+"/v1/best?tag=reasoning&limit=3", e.key)
	if res.StatusCode != 200 {
		t.Fatalf("status=%d", res.StatusCode)
	}
}

// ─── /v1/export.json ───────────────────────────────────────────

func TestExportTierGate(t *testing.T) {
	e := loadEnv(t)
	res, body := doReq(t, "GET", e.base+"/v1/export.json", e.exportKey)
	switch res.StatusCode {
	case 200:
		if !strings.Contains(res.Header.Get("content-type"), "application/json") {
			t.Fatalf("200 but bad content-type: %q", res.Header.Get("content-type"))
		}
	case 403:
		var errEnv struct {
			Error struct{ Code string } `json:"error"`
		}
		_ = json.Unmarshal(body, &errEnv)
		if errEnv.Error.Code != "tier_forbidden" {
			t.Fatalf("403 but error.code=%q", errEnv.Error.Code)
		}
	default:
		t.Fatalf("unexpected status=%d body=%s", res.StatusCode, body)
	}
}

// ─── Auth error surface ────────────────────────────────────────

func TestMissingTokenIs401(t *testing.T) {
	e := loadEnv(t)
	res, body := doReq(t, "GET", e.base+"/v1/models", "")
	if res.StatusCode != 401 {
		t.Fatalf("status=%d body=%s", res.StatusCode, body)
	}
	var errEnv struct {
		Error struct{ Code string } `json:"error"`
	}
	_ = json.Unmarshal(body, &errEnv)
	if errEnv.Error.Code != "missing_token" {
		t.Fatalf("error.code=%q", errEnv.Error.Code)
	}
}

func TestWrongPrefixIs401(t *testing.T) {
	e := loadEnv(t)
	res, body := doReq(t, "GET", e.base+"/v1/models", "pk_wrong_prefix_xxx")
	if res.StatusCode != 401 {
		t.Fatalf("status=%d body=%s", res.StatusCode, body)
	}
	var errEnv struct {
		Error struct{ Code string } `json:"error"`
	}
	_ = json.Unmarshal(body, &errEnv)
	if errEnv.Error.Code != "invalid_token" {
		t.Fatalf("error.code=%q", errEnv.Error.Code)
	}
}

func TestUnknownTokenIs401(t *testing.T) {
	e := loadEnv(t)
	bogus := "sb_live_" + strings.Repeat("0", 64)
	res, body := doReq(t, "GET", e.base+"/v1/models", bogus)
	if res.StatusCode != 401 {
		t.Fatalf("status=%d body=%s", res.StatusCode, body)
	}
	var errEnv struct {
		Error struct{ Code string } `json:"error"`
	}
	_ = json.Unmarshal(body, &errEnv)
	if errEnv.Error.Code != "invalid_token" {
		t.Fatalf("error.code=%q", errEnv.Error.Code)
	}
}

// ─── CORS preflight ────────────────────────────────────────────

func TestCORSPreflight(t *testing.T) {
	e := loadEnv(t)
	req, _ := http.NewRequest("OPTIONS", e.base+"/v1/models", nil)
	res, err := httpClient.Do(req)
	if err != nil {
		t.Fatalf("OPTIONS: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != 204 {
		t.Fatalf("status=%d", res.StatusCode)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("ACAO=%q", res.Header.Get("Access-Control-Allow-Origin"))
	}
}
