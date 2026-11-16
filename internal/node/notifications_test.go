package node

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestNotificationSettingsPartialSaveAndPersistence(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	n := s.Get().Notifications
	if n.Enabled || !n.UpdateAvailable || !n.CheckFailed || !n.UpdateSucceeded || !n.UpdateFailed || n.Bark.ServerURL != "https://api.day.app" {
		t.Fatal(n)
	}
	legacy := s.Get()
	legacy.CheckCron, legacy.UpdateCron = "30 * * * *", "0 3 * * *"
	if err := WriteJSON(filepath.Join(dir, "settings.json"), legacy); err != nil {
		t.Fatal(err)
	}
	s, err = OpenSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Patch(json.RawMessage(`{"notifications":{"enabled":true,"bark":{"serverURL":"https://bark.example/prefix/","deviceKey":"test-private-key"}}}`)); err != nil {
		t.Fatal(err)
	}
	if err := s.Patch(json.RawMessage(`{"notifications":{"updateSucceeded":false,"bark":{"deviceKey":""}},"startupCheck":false}`)); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	got := reopened.Get()
	if got.CheckCron != legacy.CheckCron || got.UpdateCron != legacy.UpdateCron || got.StartupCheck || got.Notifications.UpdateSucceeded || got.Notifications.Bark.DeviceKey != "test-private-key" || got.Notifications.Bark.ServerURL != "https://bark.example/prefix" {
		t.Fatal("局部保存丢失设置或改写计划", got)
	}
	public, _ := json.Marshal(got.Notifications.Public())
	if strings.Contains(string(public), "test-private-key") || strings.Contains(string(public), "deviceKey") || !strings.Contains(string(public), `"hasKey":true`) {
		t.Fatal("密钥在读取响应泄漏", string(public))
	}
}

func TestSettingsPatchAtomicNoopAndFailure(t *testing.T) {
	s, err := OpenSettings(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Patch(json.RawMessage(`{"excludedContainers":["original"]}`)); err != nil {
		t.Fatal(err)
	}
	before, _ := os.Stat(s.path)
	if err := s.Patch(json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(s.path)
	if !os.SameFile(before, after) || before.ModTime() != after.ModTime() {
		t.Fatal("无变化保存仍替换了设置文件")
	}
	for _, patch := range []string{`null`, `[]`, `{"checkCron":"invalid","excludedContainers":["changed"]}`, `{"notifications":{"enabled":true}}`, `{"notifications":{"bark":{"serverURL":"https://user:pass@bark.example"}}}`, `{"notifications":{"bark":{"serverURL":"file:///data"}}}`, `{"notifications":{"bark":{"serverURL":"https://bark.example?token=private"}}}`} {
		if s.Patch(json.RawMessage(patch)) == nil {
			t.Fatal("接受无效设置", patch)
		}
		if got := s.Get(); len(got.ExcludedContainers) != 1 || got.ExcludedContainers[0] != "original" {
			t.Fatal("失败修改污染了内存设置", got)
		}
	}
	path := s.path
	content, _ := os.ReadFile(path)
	s.path = filepath.Dir(path) // 原子替换目录必定失败，不依赖运行用户的权限。
	if s.Patch(json.RawMessage(`{"startupCheck":false,"excludedContainers":["changed"]}`)) == nil {
		t.Fatal("写入失败未报告")
	}
	if !s.Get().StartupCheck || s.Get().ExcludedContainers[0] != "original" {
		t.Fatal("落盘失败改变了内存配置")
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(content) {
		t.Fatal("落盘失败破坏了原文件")
	}
}

func TestConcurrentSettingsPatchesPreserveOtherCategory(t *testing.T) {
	s, err := OpenSettings(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var group sync.WaitGroup
	for _, body := range []string{`{"httpsProxy":"http://proxy.example:7890","excludedContainers":["app"]}`, `{"notifications":{"bark":{"deviceKey":"concurrent-key"},"checkFailed":false}}`, `{"keepOldContainer":true,"githubProxy":"https://mirror.example/prefix"}`} {
		group.Add(1)
		go func(body string) {
			defer group.Done()
			<-start
			if err := s.Patch(json.RawMessage(body)); err != nil {
				t.Error(err)
			}
		}(body)
	}
	close(start)
	group.Wait()
	got := s.Get()
	if got.HTTPSProxy != "http://proxy.example:7890" || len(got.ExcludedContainers) != 1 || got.Notifications.CheckFailed || got.Notifications.Bark.DeviceKey != "concurrent-key" || !got.KeepOldContainer || got.GithubProxy != "https://mirror.example/prefix" {
		t.Fatal("分类并发保存相互覆盖", got)
	}
}

func TestEitherCronFieldChangesUnifiedFrequency(t *testing.T) {
	for _, mode := range []bool{false, true} {
		for _, field := range []string{"checkCron", "updateCron"} {
			s, err := OpenSettings(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			v := s.Get()
			v.AutoUpdate = mode
			if err := s.Save(v); err != nil {
				t.Fatal(err)
			}
			patch, _ := json.Marshal(map[string]string{field: "15 2 * * *"})
			if err := s.Patch(patch); err != nil {
				t.Fatal(err)
			}
			if got := s.Get(); got.CheckCron != "15 2 * * *" || got.UpdateCron != got.CheckCron {
				t.Fatal("单字段修改频率被忽略", mode, field, got)
			}
		}
	}
}
