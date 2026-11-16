package utiles

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/onlyLTY/dockerCopilot/internal/config"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
)

func TestGithubReleaseCacheUsesSelectedPrefix(t *testing.T) {
	var first, second atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !strings.HasSuffix(r.URL.Path, "/https://api.github.com/repos/"+releaseRepository+"/releases/latest") {
			t.Error("版本查询未使用 GitHub URL 前缀", r.URL.Path)
		}
		tag := "v9.9.1"
		if strings.HasPrefix(r.URL.Path, "/second/") {
			second.Add(1)
			tag = "v9.9.2"
		} else {
			first.Add(1)
		}
		json.NewEncoder(w).Encode(map[string]string{"tag_name": tag})
	}))
	defer server.Close()
	t.Setenv("githubProxy", "https://ignored.invalid")
	for _, prefix := range []string{server.URL + "/first", server.URL + "/first/"} {
		if version, err := GetRemoteVersion(node.Settings{GithubProxy: prefix}); err != nil || version != "v9.9.1" {
			t.Fatal("保存的加速地址没有用于查询", version, err)
		}
	}
	if version, err := GetRemoteVersion(node.Settings{GithubProxy: server.URL + "/second"}); err != nil || version != "v9.9.2" || first.Load() != 1 || second.Load() != 1 {
		t.Fatal("切换加速地址后仍复用旧缓存", version, err, first.Load(), second.Load())
	}
}

func TestGithubAcceleratorBypassesProxyOtherwiseSavedProxyApplies(t *testing.T) {
	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"tag_name": "v9.8.7"})
	}))
	defer backend.Close()
	var first, second, direct atomic.Int32
	firstProxy := githubTestProxy(t, backend.Listener.Addr().String(), &first)
	secondProxy := githubTestProxy(t, backend.Listener.Addr().String(), &second)
	defer firstProxy.Close()
	defer secondProxy.Close()
	previous := http.DefaultTransport
	transport := previous.(*http.Transport).Clone()
	transport.TLSClientConfig = backend.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	transport.TLSClientConfig.ServerName = "example.com"
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address == "mirror.example:443" {
			direct.Add(1)
			address = backend.Listener.Addr().String()
		}
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}
	http.DefaultTransport = transport
	defer func() { http.DefaultTransport = previous; transport.CloseIdleConnections() }()
	settings := node.Settings{HTTPSProxy: firstProxy.URL}
	if _, err := GetRemoteVersion(settings); err != nil || first.Load() != 1 {
		t.Fatal("未设置加速地址时没有通过保存的 HTTPS 代理访问 GitHub", err, first.Load())
	}
	settings.HTTPSProxy = secondProxy.URL
	if _, err := GetRemoteVersion(settings); err != nil || second.Load() != 1 {
		t.Fatal("修改代理后仍命中旧网络配置缓存", err, second.Load())
	}
	settings.GithubProxy = "https://mirror.example/edge"
	if _, err := GetRemoteVersion(settings); err != nil || direct.Load() != 1 || second.Load() != 1 {
		t.Fatal("设置加速地址后没有直连加速服务", err, direct.Load(), second.Load())
	}
	settings.HTTPSProxy = firstProxy.URL
	if _, err := GetRemoteVersion(settings); err != nil || direct.Load() != 1 || first.Load() != 1 {
		t.Fatal("修改无关代理导致加速请求切换来源或重复查询", err)
	}
}

func githubTestProxy(t *testing.T, upstreamAddress string, count *atomic.Int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect || (r.Host != "api.github.com:443" && r.Host != "github.com:443") {
			t.Error("GitHub 请求使用了错误的代理目标", r.Method, r.Host)
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		count.Add(1)
		upstream, err := net.Dial("tcp", upstreamAddress)
		if err != nil {
			t.Error(err)
			return
		}
		defer upstream.Close()
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.Close()
		io.WriteString(connection, "HTTP/1.1 200 Connection Established\r\n\r\n")
		go io.Copy(upstream, connection)
		io.Copy(connection, upstream)
	}))
}

func TestProgramDownloadUsesSameSavedPrefixAsVersionQuery(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("在 Linux 验证完整的 ELF 更新包下载与暂存")
	}
	if _, err := os.Stat("/usr/local/lib/docker/cli-plugins/docker-compose"); err != nil {
		if _, err := os.Stat("/usr/libexec/docker/cli-plugins/docker-compose"); err != nil {
			t.Skip("需要已安装官方 Compose 插件的 Linux 测试环境")
		}
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	binary, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	gz := gzip.NewWriter(&archive)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "dockerCopilot-new", Mode: 0755, Size: int64(len(binary))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(binary); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("githubProxy", "")
	settings, err := node.OpenSettings(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	assetName := "dockerCopilot-" + runtime.GOARCH + ".tar.gz"
	assetURL := "https://github.com/" + releaseRepository + "/releases/download/v9.9.9/" + assetName
	var queries, downloads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/saved/https://api.github.com/repos/"+releaseRepository+"/releases/latest" {
			queries.Add(1)
			// 查询期间修改设置，下载仍须沿用开始时选定的来源。
			if err := settings.Patch(json.RawMessage(`{"githubProxy":"https://changed.invalid"}`)); err != nil {
				t.Error(err)
			}
			json.NewEncoder(w).Encode(map[string]any{"tag_name": "v9.9.9", "assets": []map[string]string{{"name": assetName, "browser_download_url": assetURL}}})
		} else if r.URL.Path == "/saved/"+assetURL {
			downloads.Add(1)
			w.Write(archive.Bytes())
		} else {
			t.Error("下载使用了错误的加速来源", r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()
	patch, _ := json.Marshal(map[string]string{"githubProxy": server.URL + "/saved"})
	if err := settings.Patch(patch); err != nil {
		t.Fatal(err)
	}
	t.Setenv("githubProxy", "https://ignored.invalid")
	previousVersion := config.Version
	config.Version = "v1.0.0"
	defer func() { config.Version = previousVersion }()
	previousDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	if err := os.Chdir(directory); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(previousDirectory)
	if err := UpdateProgram(&svc.ServiceContext{Settings: settings}); err != nil {
		t.Fatal(err)
	}
	staged, err := os.ReadFile(filepath.Join(directory, "dockerCopilot-new"))
	if err != nil || !bytes.Equal(staged, binary) || queries.Load() != 1 || downloads.Load() != 1 {
		t.Fatal("完整程序包未从选定来源下载并验证", err, queries.Load(), downloads.Load())
	}
	// 没有加速地址时，版本 API 和正式包下载都必须经过已保存的 HTTPS 代理。
	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host == "api.github.com" && r.URL.Path == "/repos/"+releaseRepository+"/releases/latest" {
			queries.Add(1)
			if err := settings.Patch(json.RawMessage(`{"httpsProxy":"http://changed.invalid:7890"}`)); err != nil {
				t.Error(err)
			}
			json.NewEncoder(w).Encode(map[string]any{"tag_name": "v9.9.9", "assets": []map[string]string{{"name": assetName, "browser_download_url": assetURL}}})
		} else if r.Host == "github.com" && r.URL.Path == "/"+releaseRepository+"/releases/download/v9.9.9/"+assetName {
			downloads.Add(1)
			w.Write(archive.Bytes())
		} else {
			t.Error("代理收到非预期 GitHub 请求", r.Host, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer backend.Close()
	var tunnels atomic.Int32
	proxy := githubTestProxy(t, backend.Listener.Addr().String(), &tunnels)
	defer proxy.Close()
	previousTransport := http.DefaultTransport
	transport := previousTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = backend.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	transport.TLSClientConfig.ServerName = "example.com"
	http.DefaultTransport = transport
	defer func() { http.DefaultTransport = previousTransport; transport.CloseIdleConnections() }()
	patch, _ = json.Marshal(map[string]string{"githubProxy": "", "httpsProxy": proxy.URL})
	if err := settings.Patch(patch); err != nil {
		t.Fatal(err)
	}
	if err := UpdateProgram(&svc.ServiceContext{Settings: settings}); err != nil {
		t.Fatal(err)
	}
	if queries.Load() != 2 || downloads.Load() != 2 || tunnels.Load() != 2 {
		t.Fatal("查询和下载未共用开始时保存的 HTTPS 代理", queries.Load(), downloads.Load(), tunnels.Load())
	}
}

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
