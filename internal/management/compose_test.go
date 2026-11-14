package management

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/docker/docker/client"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
)

func fileManager(t *testing.T) (*Manager, string) {
	t.Helper()
	root := t.TempDir()
	t.Setenv("COMPOSE_ROOT", root)
	t.Setenv("DATA_DIR", t.TempDir())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("[]"))
	}))
	t.Cleanup(server.Close)
	c, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.47"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return New(&svc.ServiceContext{DockerClient: c}), root
}

func TestComposeEditorPreservesTextAndDetectsConflicts(t *testing.T) {
	m, root := fileManager(t)
	dir := filepath.Join(root, "app")
	os.MkdirAll(dir, 0755)
	main := filepath.Join(dir, "compose.yaml")
	override := filepath.Join(dir, "compose.override.yaml")
	before := "# keep comment\r\nservices:\r\n  app:\r\n    image: nginx:1\r\n"
	if err := os.WriteFile(main, []byte(before), 0640); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(override, []byte("services: {}\n"), 0640)
	projects, err := m.Projects(context.Background())
	if err != nil || len(projects) != 1 {
		t.Fatal(projects, err)
	}
	p := projects[0]
	if len(p.Files) != 2 || p.Files[0] != main {
		t.Fatal("multi-file order lost", p.Files)
	}
	after := strings.Replace(before, "nginx:1", "nginx:2", 1)
	if err := m.SaveFile(context.Background(), p.ID, 0, before, after); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(main)
	if string(got) != after {
		t.Fatal("comments or newline changed")
	}
	if err := m.SaveFile(context.Background(), p.ID, 0, before, before); err == nil {
		t.Fatal("external modification was overwritten")
	}
	if err := m.SaveFile(context.Background(), p.ID, 0, after, "services: [invalid"); err == nil {
		t.Fatal("invalid YAML accepted")
	}
	got, _ = os.ReadFile(main)
	if string(got) != after {
		t.Fatal("failed save changed original")
	}
	m.Context.Operation.Lock()
	if m.SaveFile(context.Background(), p.ID, 0, after, before) == nil {
		t.Fatal("saved during deployment")
	}
	m.Context.Operation.Unlock()
	if err := os.Chmod(main, 0444); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(main, 0644) })
	if m.SaveFile(context.Background(), p.ID, 0, after, before) == nil {
		t.Fatal("read-only file accepted")
	}
}

func TestComposeRootRejectsTraversalLinksAndJSONErrors(t *testing.T) {
	m, root := fileManager(t)
	outside := filepath.Join(t.TempDir(), "compose.yaml")
	os.WriteFile(outside, []byte("services: {}"), 0600)
	if _, _, err := resolveFile(root, outside); err == nil {
		t.Fatal("outside root accepted")
	}
	if _, _, err := resolveFile(root, "../compose.yaml"); err == nil {
		t.Fatal("traversal accepted")
	}
	if err := resolveDirectory(root, filepath.Dir(outside)); err == nil {
		t.Fatal("标签工作目录越界未被拦截")
	}
	if err := resolveDirectory(root, root); err != nil {
		t.Fatal("根目录内项目被拒绝", err)
	}
	path := filepath.Join(root, "deployment.json")
	original := `{"services":{"app":{"image":"nginx:1"}}}`
	os.WriteFile(path, []byte(original), 0644)
	p, err := m.ImportProject("example", []string{path})
	if err != nil {
		t.Fatal(err)
	}
	if m.SaveFile(context.Background(), p.ID, 0, original, `{"services": }`) == nil {
		t.Fatal("bad JSON accepted")
	}
	if err := os.Symlink(outside, filepath.Join(root, "link.yaml")); err != nil {
		t.Log("symlink unavailable:", err)
		return
	}
	if _, _, err := resolveFile(root, "link.yaml"); err == nil {
		t.Fatal("symlink accepted")
	}
	if err := os.Symlink(filepath.Dir(outside), filepath.Join(root, "linked-directory")); err != nil {
		t.Fatal(err)
	}
	if err := resolveDirectory(root, filepath.Join(root, "linked-directory")); err == nil {
		t.Fatal("工作目录符号链接未被拒绝")
	}
}

func TestComposeDuplicateProjectNamesCannotDeployAcrossDirectories(t *testing.T) {
	m, root := fileManager(t)
	for _, dir := range []string{"first", "second"} {
		path := filepath.Join(root, dir)
		os.MkdirAll(path, 0755)
		os.WriteFile(filepath.Join(path, "compose.yaml"), []byte("name: repeated\nservices: {}\n"), 0644)
	}
	projects, err := m.Projects(context.Background())
	if err != nil || len(projects) != 2 {
		t.Fatal(err, projects)
	}
	for _, p := range projects {
		if _, err := m.Project(context.Background(), p.ID); err == nil {
			t.Fatal("重名项目可能影响另一个目录的服务")
		}
	}
}
