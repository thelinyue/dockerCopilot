package node

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSettingsPersistAndValidate(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://user:password@proxy.example:7890")
	s, err := OpenSettings(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if s.Get().AutoUpdate || s.Get().CheckCron != "30 * * * *" {
		t.Fatal("unsafe defaults")
	}
	t.Setenv("HTTP_PROXY", "http://different.example:7890")
	initial, err := OpenSettings(filepath.Dir(s.path))
	if err != nil || initial.Get().HTTPProxy != s.Get().HTTPProxy {
		t.Fatal("首次读取的环境代理未持久化", err)
	}
	v := s.Get()
	v.HTTPProxy = ""
	v.HTTPSProxy = "http://p.example:7890"
	v.AutoUpdate = true
	if err := s.Save(v); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenSettings(filepath.Dir(s.path))
	if err != nil || reopened.Get().HTTPProxy != "" || !reopened.Get().AutoUpdate {
		t.Fatal("saved direct connection must override environment", err)
	}
	before, _ := os.ReadFile(s.path)
	for _, mutate := range []func(*Settings){func(v *Settings) { v.CheckCron = "invalid" }, func(v *Settings) { v.HTTPSProxy = "file:///etc/passwd" }} {
		bad := v
		mutate(&bad)
		if s.Save(bad) == nil {
			t.Fatal("invalid settings accepted")
		}
		after, _ := os.ReadFile(s.path)
		if string(before) != string(after) {
			t.Fatal("invalid save changed settings")
		}
	}
	copy := s.Get()
	copy.ExcludedContainers = append(copy.ExcludedContainers, "x")
	if len(s.Get().ExcludedContainers) != 0 {
		t.Fatal("settings share mutable slices")
	}
}

func TestProxyRedaction(t *testing.T) {
	if got := RedactProxy("http://user:secret@proxy:7890"); got != "http://user:%2A%2A%2A%2A%2A%2A%2A%2A@proxy:7890" {
		t.Fatal(got)
	}
}
