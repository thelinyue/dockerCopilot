package management

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/onlyLTY/dockerCopilot/internal/config"
	"github.com/zeromicro/go-zero/rest"
)

func TestEditorAPIAllowsLargeFilesAndChecksDraftWithoutSaving(t *testing.T) {
	m, root := fileManager(t)
	path := filepath.Join(root, "compose.yaml")
	original := "# " + strings.Repeat("x", 1100000) + "\nservices: {}\n"
	content := original + "# saved through HTTP\n"
	if err := os.WriteFile(path, []byte(original), 0644); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	cfg := config.Config{}
	cfg.Host = "127.0.0.1"
	cfg.Port = port
	cfg.Auth.AccessSecret = "editor-test-secret"
	m.Context.Config = cfg
	server := rest.MustNewServer(cfg.RestConf)
	m.Routes(server)
	defer server.Stop()
	go server.Start()
	address := fmt.Sprintf("http://127.0.0.1:%d", port)
	client := &http.Client{Timeout: 5 * time.Second}
	for deadline := time.Now().Add(3 * time.Second); ; {
		r, err := client.Get(address + "/api/tasks")
		if err == nil {
			r.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	projectID := projectID(defaultProjectName(root), root)
	body, _ := json.Marshal(map[string]string{"original": original, "content": content})
	req, _ := http.NewRequest("PUT", address+"/api/compose/projects/"+projectID+"/files/0", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+signedTestToken(t, cfg.Auth.AccessSecret, time.Now().Add(time.Hour)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		msg, _ := io.ReadAll(resp.Body)
		t.Fatal("大于 1 MiB 的合法文件被请求限制拒绝", resp.StatusCode, string(msg))
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != content {
		t.Fatal("保存内容不完整", err)
	}
	body, _ = json.Marshal(map[string]string{"content": "services:\n\tapp: {}\n"})
	req, _ = http.NewRequest("POST", address+"/api/compose/projects/"+projectID+"/files/0/validate", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+signedTestToken(t, cfg.Auth.AccessSecret, time.Now().Add(time.Hour)))
	req.Header.Set("Content-Type", "application/json")
	checked, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer checked.Body.Close()
	var result struct {
		Data ComposeValidation `json:"data"`
	}
	if err := json.NewDecoder(checked.Body).Decode(&result); err != nil || checked.StatusCode != 200 || result.Data.Valid || result.Data.Line <= 0 || !strings.Contains(result.Data.Message, "空格缩进") {
		t.Fatal("草稿接口没有返回中文错误和行号", checked.StatusCode, result, err)
	}
	got, err = os.ReadFile(path)
	if err != nil || string(got) != content || len(m.Context.Tasks()) != 0 {
		t.Fatal("自动检查改写了原文或创建了任务", err)
	}
}
