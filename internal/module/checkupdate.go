package module

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	ref "github.com/distribution/reference"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"golang.org/x/net/http/httpproxy"
)

type ImageCheckList struct {
	NeedUpdate bool      `json:"needUpdate"`
	Error      string    `json:"error,omitempty"`
	CheckedAt  time.Time `json:"checkedAt"`
}
type ImageUpdateData struct {
	mu   sync.RWMutex
	data map[string]ImageCheckList
}

func NewImageCheck() *ImageUpdateData { return &ImageUpdateData{data: map[string]ImageCheckList{}} }
func (i *ImageUpdateData) Set(key string, value ImageCheckList) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.data[key] = value
}
func (i *ImageUpdateData) Get(key string) (ImageCheckList, bool) {
	i.mu.RLock()
	defer i.mu.RUnlock()
	v, ok := i.data[key]
	return v, ok
}
func (i *ImageUpdateData) Clear() {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.data = map[string]ImageCheckList{}
}

func RegistryClient(settings node.Settings) *http.Client {
	proxy := (&httpproxy.Config{HTTPProxy: settings.HTTPProxy, HTTPSProxy: settings.HTTPSProxy}).ProxyFunc()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = func(r *http.Request) (*url.URL, error) { return proxy(r.URL) }
	return &http.Client{Transport: transport, Timeout: 25 * time.Second}
}

type descriptor struct {
	Digest   string `json:"digest"`
	Platform struct {
		OS           string `json:"os"`
		Architecture string `json:"architecture"`
		Variant      string `json:"variant"`
	} `json:"platform"`
}
type manifest struct {
	Config    descriptor   `json:"config"`
	Manifests []descriptor `json:"manifests"`
}

const manifestAccept = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"

// 比较当前平台的 config digest 和本地 image ID，避免多架构索引摘要造成误判；不下载镜像层。
func CheckReference(ctx context.Context, client *http.Client, imageRef, imageID, osName, arch, variant string) (bool, error) {
	named, err := ref.ParseNormalizedNamed(imageRef)
	if err != nil {
		return false, fmt.Errorf("镜像引用无效")
	}
	if _, pinned := named.(ref.Canonical); pinned {
		return false, nil
	}
	named = ref.TagNameOnly(named)
	tagged, ok := named.(ref.NamedTagged)
	if !ok {
		return false, fmt.Errorf("镜像没有可检测的标签")
	}
	host := ref.Domain(named)
	if host == "docker.io" {
		host = "registry-1.docker.io"
	}
	base := "https://" + host + "/v2/" + ref.Path(named) + "/manifests/"
	token := ""
	for depth, target := 0, tagged.Tag(); depth < 3; depth++ {
		m, nextToken, err := fetchManifest(ctx, client, base+target, token, named)
		if err != nil {
			return false, err
		}
		token = nextToken
		if m.Config.Digest != "" {
			return m.Config.Digest != imageID, nil
		}
		target = ""
		for _, desc := range m.Manifests {
			if desc.Platform.OS == osName && desc.Platform.Architecture == arch && normalizedVariant(arch, desc.Platform.Variant) == normalizedVariant(arch, variant) {
				target = desc.Digest
				break
			}
		}
		if target == "" {
			return false, fmt.Errorf("远端镜像不包含当前平台 %s/%s/%s", osName, arch, variant)
		}
	}
	return false, fmt.Errorf("镜像 manifest 嵌套过深或缺少 config digest")
}

func normalizedVariant(arch, variant string) string {
	// OCI 的默认 arm64/v8 和 amd64/v1 常省略；不能误选需要更高指令集的变体。
	if (arch == "arm64" && variant == "v8") || (arch == "amd64" && variant == "v1") {
		return ""
	}
	return variant
}

func fetchManifest(ctx context.Context, client *http.Client, address, token string, named ref.Named) (manifest, string, error) {
	for attempt := 0; attempt < 2; attempt++ {
		r, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
		if err != nil {
			return manifest{}, token, err
		}
		r.Header.Set("Accept", manifestAccept)
		if token != "" {
			r.Header.Set("Authorization", token)
		}
		resp, err := client.Do(r)
		if err != nil {
			return manifest{}, token, fmt.Errorf("镜像检测请求失败，请检查网络、代理和证书")
		}
		if resp.StatusCode == 401 && attempt == 0 {
			challenge := resp.Header.Get("WWW-Authenticate")
			resp.Body.Close()
			token, err = bearerToken(ctx, client, challenge, named)
			if err != nil {
				return manifest{}, token, err
			}
			continue
		}
		if resp.StatusCode != 200 {
			resp.Body.Close()
			return manifest{}, token, fmt.Errorf("镜像仓库返回 HTTP %d，请检查访问权限或限流", resp.StatusCode)
		}
		var m manifest
		err = json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&m)
		resp.Body.Close()
		if err != nil {
			return m, token, fmt.Errorf("镜像仓库返回无效 manifest")
		}
		return m, token, nil
	}
	return manifest{}, token, fmt.Errorf("镜像仓库认证失败")
}

func bearerToken(ctx context.Context, client *http.Client, challenge string, named ref.Named) (string, error) {
	u, err := GetAuthURL(challenge, named)
	if err != nil {
		return "", err
	}
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(r)
	if err != nil {
		return "", fmt.Errorf("获取镜像仓库令牌失败，请检查代理和网络")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("获取镜像仓库令牌失败 (HTTP %d)，私有仓库请检查认证", resp.StatusCode)
	}
	var v struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&v) != nil {
		return "", fmt.Errorf("镜像仓库令牌格式无效")
	}
	if v.Token == "" {
		v.Token = v.AccessToken
	}
	if v.Token == "" {
		return "", fmt.Errorf("镜像仓库未返回令牌")
	}
	return "Bearer " + v.Token, nil
}

// 只对认证方案和参数名忽略大小写，realm/service/scope 的值必须保持原样。
func GetAuthURL(challenge string, imageRef ref.Named) (*url.URL, error) {
	kind, raw, _ := strings.Cut(strings.TrimSpace(challenge), " ")
	if !strings.EqualFold(kind, "bearer") {
		return nil, fmt.Errorf("镜像仓库要求认证，当前无法获取公开令牌")
	}
	values := map[string]string{}
	for _, pair := range strings.Split(raw, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(pair), "=")
		if ok {
			values[strings.ToLower(k)] = strings.Trim(v, `"`)
		}
	}
	u, err := url.Parse(values["realm"])
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return nil, fmt.Errorf("镜像仓库认证地址无效，必须使用 HTTPS")
	}
	q := u.Query()
	if values["service"] != "" {
		q.Set("service", values["service"])
	}
	scope := values["scope"]
	if scope == "" {
		scope = "repository:" + ref.Path(imageRef) + ":pull"
	}
	q.Set("scope", scope)
	u.RawQuery = q.Encode()
	return u, nil
}
