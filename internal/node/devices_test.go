package node

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestDeviceCredentialsRefreshAndIsolation(t *testing.T) {
	var auths, writes atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth" {
			if r.FormValue("secretKey") != "device-secret" {
				t.Error("wrong credential")
			}
			n := auths.Add(1)
			json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]string{"jwt": string(rune('a' + n))}})
			return
		}
		if r.Header.Get(DeviceHeader) != "" || r.Header.Get("Cookie") != "" || len(r.Header.Values("Authorization")) != 1 || r.Header.Get("Proxy-Authorization") != "" {
			t.Error("remote recursion or browser cookie leaked")
		}
		if r.Header.Get("Authorization") == "Bearer b" {
			w.WriteHeader(401)
			return
		}
		writes.Add(1)
		json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]string{"version": "test"}})
	}))
	defer remote.Close()
	d, _ := OpenDevices(t.TempDir())
	v, err := d.Save(Device{Name: "test", Address: remote.URL, Secret: "device-secret"})
	if err != nil {
		t.Fatal(err)
	}
	serialized, _ := json.Marshal(d.List())
	if strings.Contains(string(serialized), "secret") {
		t.Fatal("credential returned to browser")
	}
	stored, _ := d.Find(v.ID)
	resp, err := d.Request(stored, "POST", "/api/start", []byte(`{}`), http.Header{DeviceHeader: {"other"}, "Cookie": {"private"}, "authorization": {"Bearer main-secret"}, "Proxy-Authorization": {"private-proxy"}})
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if auths.Load() != 2 || writes.Load() != 1 {
		t.Fatalf("auth refresh or duplicate mutation: %d/%d", auths.Load(), writes.Load())
	}
	reopened, err := OpenDevices(strings.TrimSuffix(d.path, "devices.json"))
	if err != nil {
		t.Fatal(err)
	}
	v2, ok := reopened.Find(v.ID)
	if !ok || v2.Secret != "device-secret" {
		t.Fatal("device credential did not persist")
	}
	if _, err := d.Save(Device{ID: v.ID, Name: "renamed", Address: remote.URL}); err != nil {
		t.Fatal(err)
	}
	v2, _ = d.Find(v.ID)
	if v2.Secret != "device-secret" {
		t.Fatal("empty edit replaced secret")
	}
}

func TestAmbiguousRemoteMutationIsNotRetried(t *testing.T) {
	var writes atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth" {
			json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]string{"jwt": "remote-token"}})
			return
		}
		writes.Add(1)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		conn.Close()
	}))
	defer remote.Close()
	d, _ := OpenDevices(t.TempDir())
	v := Device{ID: "remote", Address: remote.URL, Secret: "device-secret"}
	if _, err := d.Request(v, "POST", "/api/compose/projects/test/actions", []byte(`{"action":"deploy"}`), http.Header{"Idempotency-Key": {"browser-key"}}); err == nil {
		t.Fatal("连接中断不能报告成功")
	}
	if writes.Load() != 1 {
		t.Fatal("结果不明的部署被重复执行", writes.Load())
	}
}
