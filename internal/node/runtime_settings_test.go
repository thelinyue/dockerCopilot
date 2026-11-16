package node

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestRuntimeSettingsMigrateOnlyMissingFieldsOnce(t *testing.T) {
	for _, tc := range []struct {
		name, content       string
		keep                bool
		http, https, github string
	}{
		{name: "首次初始化", keep: true, http: "http://legacy.example:7890", https: "http://legacy.example:7891", github: "https://mirror.example/prefix"},
		{name: "旧文件缺失字段", content: `{"checkCron":"30 * * * *","updateCron":"0 3 * * *","excludedContainers":["app"]}`, keep: true, http: "http://legacy.example:7890", https: "http://legacy.example:7891", github: "https://mirror.example/prefix"},
		{name: "已有显式空值和false", content: `{"httpProxy":"","httpsProxy":"","githubProxy":"","keepOldContainer":false}`},
		{name: "逐字段保留", content: `{"httpProxy":"http://saved.example:7890","httpsProxy":"","keepOldContainer":true}`, keep: true, http: "http://saved.example:7890", github: "https://mirror.example/prefix"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("HTTP_PROXY", "http://legacy.example:7890")
			t.Setenv("HTTPS_PROXY", "http://legacy.example:7891")
			t.Setenv("githubProxy", " https://mirror.example/prefix/// ")
			t.Setenv("DelOldContainer", "false")
			dir := t.TempDir()
			path := filepath.Join(dir, "settings.json")
			if tc.content != "" {
				if err := os.WriteFile(path, []byte(tc.content), 0600); err != nil {
					t.Fatal(err)
				}
			}
			store, err := OpenSettings(dir)
			if err != nil {
				t.Fatal(err)
			}
			got := store.Get()
			if got.KeepOldContainer != tc.keep || got.HTTPProxy != tc.http || got.HTTPSProxy != tc.https || got.GithubProxy != tc.github {
				t.Fatal("迁移覆盖已有设置或遗漏旧配置", got)
			}
			if tc.name == "旧文件缺失字段" && (got.UpdateCron != "0 3 * * *" || len(got.ExcludedContainers) != 1) {
				t.Fatal("迁移改写了其他设置", got)
			}
			before, _ := os.ReadFile(path)
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(before, &fields); err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"httpProxy", "httpsProxy", "githubProxy", "keepOldContainer"} {
				if _, exists := fields[key]; !exists {
					t.Fatal("迁移未持久化默认值", key)
				}
			}
			t.Setenv("HTTP_PROXY", "invalid")
			t.Setenv("HTTPS_PROXY", "invalid")
			t.Setenv("githubProxy", "invalid")
			t.Setenv("DelOldContainer", "true")
			reopened, err := OpenSettings(dir)
			if err != nil || !reflect.DeepEqual(reopened.Get(), got) {
				t.Fatal("重启仍受旧环境变量影响", err)
			}
			after, _ := os.ReadFile(path)
			if string(before) != string(after) {
				t.Fatal("重启重复迁移设置")
			}
		})
	}
}

func TestRuntimeSettingsPersistEmptyDefaultsBeforeLaterEnvironment(t *testing.T) {
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "githubProxy", "DelOldContainer"} {
		t.Setenv(key, "")
	}
	dir := t.TempDir()
	store, err := OpenSettings(dir)
	if err != nil || store.Get().KeepOldContainer || store.Get().GithubProxy != "" {
		t.Fatal("新安装默认值不正确", err)
	}
	t.Setenv("DelOldContainer", "false")
	t.Setenv("githubProxy", "https://later.example")
	reopened, err := OpenSettings(dir)
	if err != nil || !reflect.DeepEqual(store.Get(), reopened.Get()) {
		t.Fatal("默认值未持久化，后加环境变量改变了策略", err)
	}
}

func TestInvalidRuntimeMigrationKeepsOriginalFile(t *testing.T) {
	t.Setenv("githubProxy", "socks5://unsupported.example:1080")
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	before := `{"checkCron":"30 * * * *","excludedContainers":["preserve"]}`
	if err := os.WriteFile(path, []byte(before), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenSettings(dir); err == nil {
		t.Fatal("迁移接受了无效加速地址")
	}
	after, _ := os.ReadFile(path)
	if string(after) != before {
		t.Fatal("迁移失败破坏了原配置")
	}
}

func TestRuntimeSettingsPatchValidationAndMaskedRoundTrip(t *testing.T) {
	store, err := OpenSettings(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Patch(json.RawMessage(`{"keepOldContainer":true,"githubProxy":" https://user:fixture-credential@mirror.example/prefix/// "}`)); err != nil {
		t.Fatal(err)
	}
	before := store.Get()
	masked, _ := json.Marshal(map[string]any{"githubProxy": RedactProxy(before.GithubProxy), "startupCheck": false})
	if err := store.Patch(masked); err != nil || store.Get().GithubProxy != before.GithubProxy || !store.Get().KeepOldContainer {
		t.Fatal("掩码回写丢失凭据或保留策略", err)
	}
	for _, patch := range []string{
		`{"keepOldContainer":"false"}`, `{"githubProxy":"socks5://mirror.example"}`,
		`{"githubProxy":"https://mirror.example?token=demo"}`, `{"githubProxy":"https://mirror.example/#fragment"}`,
		`{"githubProxy":"https://user:********@different.example"}`,
	} {
		if err := store.Patch(json.RawMessage(patch)); err == nil {
			t.Fatal("接受无效运行设置", patch)
		}
		if store.Get().GithubProxy != before.GithubProxy || !store.Get().KeepOldContainer {
			t.Fatal("失败保存污染了已有设置")
		}
	}
	if err := store.Patch(json.RawMessage(`{"keepOldContainer":false,"githubProxy":""}`)); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenSettings(filepath.Dir(store.path))
	if err != nil || reopened.Get().KeepOldContainer || reopened.Get().GithubProxy != "" {
		t.Fatal("关闭保留或清空直连无法持久化", err)
	}
}
