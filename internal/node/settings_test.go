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
	if s.Get().AutoUpdate || s.Get().CheckCron != "30 * * * *" || s.Get().UpdateCron != s.Get().CheckCron {
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

func TestUnifiedScheduleMigratesLegacySettingsWithoutIncreasingUpdateFrequency(t *testing.T) {
	for _, auto := range []bool{false, true} {
		t.Run(map[bool]string{false: "只检测", true: "自动更新"}[auto], func(t *testing.T) {
			dir := t.TempDir()
			legacy := Settings{CheckCron: "30 * * * *", UpdateCron: "0 3 * * *", AutoUpdate: auto, StartupCheck: true, HTTPProxy: "http://user:secret@proxy:7890", ExcludedContainers: []string{"stopped"}, ExcludedServices: []string{"project/app"}}
			if err := WriteJSON(filepath.Join(dir, "settings.json"), legacy); err != nil {
				t.Fatal(err)
			}
			store, err := OpenSettings(dir)
			if err != nil {
				t.Fatal(err)
			}
			want := legacy.CheckCron
			if auto {
				want = legacy.UpdateCron
			}
			if got := store.Get(); got.ScheduleCron() != want || got.CheckCron == got.UpdateCron {
				t.Fatal("旧配置未按原启用模式选择频率，或读取时就被覆盖", got)
			}
			v := store.Get()
			v.AutoUpdate = !auto
			if err := store.Save(v); err != nil {
				t.Fatal(err)
			}
			reopened, err := OpenSettings(dir)
			if err != nil {
				t.Fatal(err)
			}
			got := reopened.Get()
			if got.CheckCron != want || got.UpdateCron != want || got.AutoUpdate != !auto || !got.StartupCheck || got.HTTPProxy != legacy.HTTPProxy || len(got.ExcludedContainers) != 1 || len(got.ExcludedServices) != 1 {
				t.Fatal("切换模式改变了频率或丢失已有设置", got)
			}
		})
	}
}

func TestLegacyEnabledUpdateWithoutCronKeepsDailyDefault(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"autoUpdate":true,"checkCron":"30 * * * *"}`), 0600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenSettings(dir)
	if err != nil || store.Get().ScheduleCron() != "0 3 * * *" {
		t.Fatal("缺少旧字段的配置扩大了自动更新频率", err)
	}
}
