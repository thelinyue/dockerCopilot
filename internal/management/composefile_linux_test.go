//go:build linux

package management

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestDiscoveryRejectsFIFOWithoutBlocking(t *testing.T) {
	m, root := fileManager(t)
	if err := unix.Mkfifo(filepath.Join(root, "compose.yaml"), 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		projects, err := m.Projects(context.Background())
		if err == nil && (len(projects) != 1 || projects[0].Error == "") {
			err = fmt.Errorf("特殊文件未标记为不可管理")
		}
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal("特殊文件应显示项目错误", err)
		}
	case <-time.After(time.Second):
		t.Fatal("项目扫描阻塞在特殊文件上")
	}
}
