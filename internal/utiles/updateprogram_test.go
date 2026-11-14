package utiles

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestProgramArchiveCannotOverwriteFiles(t *testing.T) {
	for _, entry := range []struct {
		name string
		kind byte
	}{{"../config.json", tar.TypeReg}, {"dockerCopilot-new", tar.TypeSymlink}, {"unexpected", tar.TypeReg}, {"dist/linux/amd64/dockerCopilot-new", tar.TypeReg}} {
		t.Run(entry.name, func(t *testing.T) {
			dir := t.TempDir()
			sentinel := filepath.Join(dir, "dockerCopilot-new")
			os.WriteFile(sentinel, []byte("previous"), 0600)
			var archive bytes.Buffer
			gz := gzip.NewWriter(&archive)
			tw := tar.NewWriter(gz)
			header := &tar.Header{Name: entry.name, Typeflag: entry.kind, Mode: 0755, Size: 7}
			if entry.kind == tar.TypeSymlink {
				header.Size = 0
				header.Linkname = "/etc/passwd"
			}
			tw.WriteHeader(header)
			if header.Size > 0 {
				tw.Write([]byte("invalid"))
			}
			tw.Close()
			gz.Close()
			if err := stageProgram(&archive, dir, "amd64"); err == nil {
				t.Fatal("untrusted program accepted")
			}
			b, _ := os.ReadFile(sentinel)
			if string(b) != "previous" {
				t.Fatal("failed update replaced staged program")
			}
		})
	}
}
func TestProgramVersionNeverDowngrades(t *testing.T) {
	for _, v := range []struct {
		current, remote string
		want            bool
	}{{"v2.1.3", "v2.1.4", true}, {"v2.2.0", "v2.1.4", false}, {"v2.1.3", "v2.1.3", false}, {"unknown", "v2.1.4", false}} {
		if HasNewProgramVersion(v.current, v.remote) != v.want {
			t.Fatal(v)
		}
	}
}

// 显式指定本地跨架构构建产物后，可离线验证正式包的接收路径，无需下载 Release。
func TestProgramBuiltArtifact(t *testing.T) {
	fixture := os.Getenv("DOCKERCOPILOT_PROGRAM_FIXTURE")
	if fixture == "" {
		t.Skip("未提供本地 Linux 构建产物")
	}
	arch := os.Getenv("DOCKERCOPILOT_PROGRAM_ARCH")
	if arch == "" {
		arch = runtime.GOARCH
	}
	f, err := os.Open(fixture)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	gz := gzip.NewWriter(&archive)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "dist/linux/" + arch + "/dockerCopilot-new", Mode: 0755, Typeflag: tar.TypeReg, Size: info.Size()}); err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(tw, f); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	wrongArch := "amd64"
	if arch == "amd64" {
		wrongArch = "arm64"
	}
	if err := stageProgram(bytes.NewReader(archive.Bytes()), dir, wrongArch); err == nil {
		t.Fatal("架构不匹配的构建被安装")
	}
	if err := stageProgram(bytes.NewReader(archive.Bytes()), dir, arch); err != nil {
		t.Fatal("合法构建未被接收", err)
	}
	staged, err := os.Stat(filepath.Join(dir, "dockerCopilot-new"))
	if err != nil || staged.Size() != info.Size() {
		t.Fatal("构建包不完整", err)
	}
}
