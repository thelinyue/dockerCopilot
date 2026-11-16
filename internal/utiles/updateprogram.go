package utiles

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"debug/elf"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/onlyLTY/dockerCopilot/internal/config"
	"github.com/onlyLTY/dockerCopilot/internal/module"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"golang.org/x/mod/semver"
)

const releaseRepository = "thelinyue/dockerCopilot"

var releaseCache struct {
	sync.Mutex
	release                       programRelease
	until                         time.Time
	prefix, httpProxy, httpsProxy string
}

type programRelease struct {
	Tag        string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
	Assets     []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

func githubAddress(prefix, address string) string {
	prefix = strings.TrimRight(strings.TrimSpace(prefix), "/")
	if prefix != "" {
		return prefix + "/" + address
	}
	return address
}
func programClient(settings node.Settings) *http.Client {
	// GitHub 加速服务优先直连；没有加速前缀时才使用共享代理访问 GitHub。
	if strings.TrimSpace(settings.GithubProxy) != "" {
		settings.HTTPProxy, settings.HTTPSProxy = "", ""
	}
	client := module.ProxyClient(settings)
	client.Timeout = 60 * time.Second
	return client
}
func latestProgramRelease(settings node.Settings) (programRelease, error) {
	prefix := strings.TrimRight(strings.TrimSpace(settings.GithubProxy), "/")
	releaseCache.Lock()
	defer releaseCache.Unlock()
	sameProxy := prefix != "" || (settings.HTTPProxy == releaseCache.httpProxy && settings.HTTPSProxy == releaseCache.httpsProxy)
	if prefix == releaseCache.prefix && sameProxy && time.Now().Before(releaseCache.until) {
		return releaseCache.release, nil
	}
	client := programClient(settings)
	defer client.CloseIdleConnections()
	resp, err := client.Get(githubAddress(prefix, "https://api.github.com/repos/"+releaseRepository+"/releases/latest"))
	if err != nil {
		return programRelease{}, fmt.Errorf("无法读取本仓库正式版本，请检查网络代理或 GitHub 加速地址")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return programRelease{}, fmt.Errorf("本仓库暂无可用正式版本或请求受限 (HTTP %d)", resp.StatusCode)
	}
	var r programRelease
	if json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&r) != nil || r.Draft || r.Prerelease || !regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$`).MatchString(r.Tag) {
		return r, fmt.Errorf("正式版本信息无效")
	}
	releaseCache.release = r
	releaseCache.prefix = prefix
	releaseCache.httpProxy = settings.HTTPProxy
	releaseCache.httpsProxy = settings.HTTPSProxy
	releaseCache.until = time.Now().Add(5 * time.Minute)
	return r, nil
}
func GetRemoteVersion(settings node.Settings) (string, error) {
	r, err := latestProgramRelease(settings)
	return r.Tag, err
}
func HasNewProgramVersion(current, remote string) bool {
	return semver.IsValid(remote) && semver.IsValid(current) && semver.Compare(remote, current) > 0
}

func UpdateProgram(s *svc.ServiceContext) error {
	if strings.HasSuffix(config.Version, "-dev") {
		return fmt.Errorf("开发版本请通过构建或升级容器镜像更新")
	}
	// 查询和下载共用同一份设置快照，避免下载期间改设置导致地址来源不一致。
	settings := s.Settings.Get()
	r, err := latestProgramRelease(settings)
	if err != nil {
		return err
	}
	if !HasNewProgramVersion(config.Version, r.Tag) {
		return fmt.Errorf("没有比当前版本更新的正式版本；开发版请通过容器镜像升级")
	}
	// 新版本依赖 Compose 插件，旧容器只替换二进制无法补齐系统工具。
	if _, err := os.Stat("/usr/local/lib/docker/cli-plugins/docker-compose"); err != nil {
		// Alpine 软件包可能安装在 /usr/libexec；通过节点能力检查使用官方 CLI。
		if _, err := os.Stat("/usr/libexec/docker/cli-plugins/docker-compose"); err != nil {
			return fmt.Errorf("当前镜像缺少随版本配套的 Compose 插件，请先升级 DockerCopilot 容器镜像")
		}
	}
	wanted := "dockerCopilot-" + runtime.GOARCH + ".tar.gz"
	address := ""
	for _, a := range r.Assets {
		if a.Name == wanted {
			address = a.URL
			break
		}
	}
	expected := "https://github.com/" + releaseRepository + "/releases/download/" + url.PathEscape(r.Tag) + "/" + wanted
	if address != expected {
		return fmt.Errorf("正式版本缺少当前架构 %s 的可信资源", runtime.GOARCH)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", githubAddress(settings.GithubProxy, address), nil)
	if err != nil {
		return err
	}
	client := programClient(settings)
	defer client.CloseIdleConnections()
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("下载正式版本失败，请检查网络代理或 GitHub 加速地址")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("下载正式版本失败 (HTTP %d)", resp.StatusCode)
	}
	return stageProgram(resp.Body, ".", runtime.GOARCH)
}

// 仅接收一个预期二进制，不按压缩包提供的路径解压，避免覆盖配置、密钥或任意宿主机文件。
func stageProgram(reader io.Reader, directory, arch string) error {
	gz, err := gzip.NewReader(io.LimitReader(reader, 200<<20))
	if err != nil {
		return fmt.Errorf("更新包格式无效")
	}
	defer gz.Close()
	tarReader := tar.NewReader(gz)
	file, err := os.CreateTemp(directory, ".dockercopilot-update-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	found := false
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("读取更新包失败")
		}
		if header.Typeflag == tar.TypeDir {
			continue
		}
		name := path.Clean(header.Name)
		if header.Typeflag != tar.TypeReg || strings.HasPrefix(name, "/") || strings.HasPrefix(name, "../") || path.Base(name) != "dockerCopilot-new" || found || header.Size <= 0 || header.Size > 200<<20 {
			return fmt.Errorf("更新包包含非预期文件，已拒绝安装")
		}
		if _, err := io.CopyN(file, tarReader, header.Size); err != nil {
			return err
		}
		found = true
	}
	if !found {
		return fmt.Errorf("更新包缺少 dockerCopilot-new")
	}
	if _, err := io.Copy(io.Discard, gz); err != nil {
		return fmt.Errorf("更新包完整性检查失败")
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	bin, err := elf.Open(file.Name())
	if err != nil {
		return fmt.Errorf("更新资源不是有效 Linux 程序")
	}
	defer bin.Close()
	if (arch == "amd64" && bin.Machine != elf.EM_X86_64) || (arch == "arm64" && bin.Machine != elf.EM_AARCH64) {
		return fmt.Errorf("更新程序架构不匹配")
	}
	bin.Close()
	// trimpath 构建不保留 ldflags，不能据此倒推程序版本；版本已在 Release 标签和精确资源 URL 中核对。
	if err := os.Chmod(file.Name(), 0755); err != nil {
		return err
	}
	return os.Rename(file.Name(), path.Join(directory, "dockerCopilot-new"))
}
