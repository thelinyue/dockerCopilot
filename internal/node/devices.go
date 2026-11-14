package node

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const DeviceHeader = "X-DockerCopilot-Device-ID"

type Device struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Address string `json:"address"`
	Secret  string `json:"secret,omitempty"`
}
type cachedToken struct {
	token string
	until time.Time
}
type Devices struct {
	mu     sync.Mutex
	path   string
	items  []Device
	tokens map[string]cachedToken
	client *http.Client
}

func OpenDevices(dir string) (*Devices, error) {
	// 节点连接不使用镜像检测代理，也不跟随重定向，避免把登录密钥发往其他地址。
	d := &Devices{path: filepath.Join(dir, "devices.json"), items: []Device{}, tokens: map[string]cachedToken{}, client: &http.Client{
		Timeout: 25 * time.Second, Transport: &http.Transport{Proxy: nil},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
	b, err := os.ReadFile(d.path)
	if err == nil {
		err = json.Unmarshal(b, &d.items)
	} else if os.IsNotExist(err) {
		err = nil
	}
	return d, err
}

func (d *Devices) List() []Device {
	d.mu.Lock()
	defer d.mu.Unlock()
	items := append([]Device{}, d.items...)
	for i := range items {
		items[i].Secret = ""
	}
	return items
}
func (d *Devices) Find(id string) (Device, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, v := range d.items {
		if v.ID == id {
			return v, true
		}
	}
	return Device{}, false
}
func (d *Devices) Save(v Device) (Device, error) {
	u, err := url.Parse(strings.TrimRight(v.Address, "/"))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return Device{}, fmt.Errorf("设备地址无效，请填写 http(s)://主机:端口")
	}
	if strings.TrimSpace(v.Name) == "" {
		return Device{}, fmt.Errorf("请填写设备名称")
	}
	v.Address = strings.TrimRight(u.String(), "/")
	d.mu.Lock()
	defer d.mu.Unlock()
	items := append([]Device{}, d.items...)
	index := -1
	for i := range items {
		if items[i].ID == v.ID {
			index = i
			if v.Secret == "" {
				v.Secret = items[i].Secret
			}
			break
		}
	}
	if v.Secret == "" {
		return Device{}, fmt.Errorf("请填写远端登录密钥")
	}
	if v.ID == "" {
		v.ID = uuid.NewString()
	} else if index < 0 {
		return Device{}, fmt.Errorf("设备不存在，请刷新列表")
	}
	if index < 0 {
		items = append(items, v)
	} else {
		items[index] = v
	}
	if err = WriteJSON(d.path, items); err != nil {
		return Device{}, err
	}
	d.items = items
	delete(d.tokens, v.ID)
	v.Secret = ""
	return v, nil
}
func (d *Devices) Delete(id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	items := make([]Device, 0, len(d.items))
	for _, v := range d.items {
		if v.ID != id {
			items = append(items, v)
		}
	}
	if err := WriteJSON(d.path, items); err != nil {
		return err
	}
	d.items = items
	delete(d.tokens, id)
	return nil
}

func (d *Devices) token(v Device) (string, error) {
	d.mu.Lock()
	cached := d.tokens[v.ID]
	d.mu.Unlock()
	if cached.token != "" && time.Now().Before(cached.until) {
		return cached.token, nil
	}
	body := url.Values{"secretKey": {v.Secret}}
	r, err := http.NewRequest(http.MethodPost, v.Address+"/api/auth", strings.NewReader(body.Encode()))
	if err != nil {
		return "", err
	}
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := d.client.Do(r)
	if err != nil {
		return "", fmt.Errorf("连接远端失败，请检查地址和网络")
	}
	defer resp.Body.Close()
	var result struct {
		Code int `json:"code"`
		Data struct {
			JWT string `json:"jwt"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result) != nil || resp.StatusCode != 200 || result.Data.JWT == "" {
		return "", fmt.Errorf("远端认证失败，请检查该设备登录密钥")
	}
	d.mu.Lock()
	d.tokens[v.ID] = cachedToken{result.Data.JWT, time.Now().Add(15 * time.Minute)}
	d.mu.Unlock()
	return result.Data.JWT, nil
}

func (d *Devices) Request(v Device, method, path string, body []byte, headers http.Header) (*http.Response, error) {
	for attempt := 0; attempt < 2; attempt++ {
		token, err := d.token(v)
		if err != nil {
			return nil, err
		}
		r, err := http.NewRequest(method, v.Address+path, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		r.Header = headers.Clone()
		for key := range r.Header {
			if strings.EqualFold(key, DeviceHeader) || strings.EqualFold(key, "Cookie") || strings.EqualFold(key, "Authorization") || strings.EqualFold(key, "Proxy-Authorization") || strings.EqualFold(key, "Host") || strings.EqualFold(key, "Idempotency-Key") || strings.EqualFold(key, "X-Idempotency-Key") {
				delete(r.Header, key)
			}
		}
		r.GetBody = nil
		r.Header.Set("Authorization", "Bearer "+token)
		resp, err := d.client.Do(r)
		// 仅明确的 401 可以重新认证；超时无法确定操作是否执行，不重试变更请求。
		if err != nil {
			return nil, fmt.Errorf("远端请求失败或超时，请检查设备；变更结果请在任务列表确认")
		}
		if resp.StatusCode != http.StatusUnauthorized || attempt == 1 {
			return resp, nil
		}
		resp.Body.Close()
		d.mu.Lock()
		delete(d.tokens, v.ID)
		d.mu.Unlock()
	}
	return nil, fmt.Errorf("远端认证失败")
}

func (d *Devices) Info(v Device) (json.RawMessage, error) {
	resp, err := d.Request(v, http.MethodGet, "/api/node/info", nil, make(http.Header))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var result struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result); err != nil || resp.StatusCode != 200 || result.Code != 200 || len(result.Data) == 0 {
		return nil, fmt.Errorf("该设备不支持完整接管，请先升级 DockerCopilot")
	}
	var info struct {
		Version      string          `json:"version"`
		Capabilities map[string]bool `json:"capabilities"`
	}
	if json.Unmarshal(result.Data, &info) != nil || info.Version == "" {
		return nil, fmt.Errorf("无法确认设备版本，请先升级远端 DockerCopilot")
	}
	for _, required := range []string{"compose", "composeEditing", "schedules", "devices"} {
		if !info.Capabilities[required] {
			name := map[string]string{"compose": "项目管理", "composeEditing": "项目编辑", "schedules": "定时任务", "devices": "多设备管理"}[required]
			return nil, fmt.Errorf("设备 %s 缺少%s能力，请先升级远端 DockerCopilot 镜像", info.Version, name)
		}
	}
	return result.Data, nil
}
