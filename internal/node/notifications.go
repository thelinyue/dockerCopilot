package node

import (
	"fmt"
	"net/url"
	"strings"
)

type BarkSettings struct {
	ServerURL string `json:"serverURL"`
	DeviceKey string `json:"deviceKey,omitempty"`
}

type NotificationSettings struct {
	Enabled         bool         `json:"enabled"`
	UpdateAvailable bool         `json:"updateAvailable"`
	CheckFailed     bool         `json:"checkFailed"`
	UpdateSucceeded bool         `json:"updateSucceeded"`
	UpdateFailed    bool         `json:"updateFailed"`
	Bark            BarkSettings `json:"bark"`
}

func DefaultNotifications() NotificationSettings {
	return NotificationSettings{UpdateAvailable: true, CheckFailed: true, UpdateSucceeded: true, UpdateFailed: true, Bark: BarkSettings{ServerURL: "https://api.day.app"}}
}

func (b BarkSettings) Validate(requireKey bool) error {
	u, err := url.Parse(b.ServerURL)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return fmt.Errorf("Bark 服务器地址无效，请填写 http(s)://主机:端口，可包含服务路径")
	}
	if requireKey && strings.TrimSpace(b.DeviceKey) == "" {
		return fmt.Errorf("请填写 Bark 设备密钥，可在 Bark App 中获取")
	}
	return nil
}

func (n NotificationSettings) Validate() error { return n.Bark.Validate(n.Enabled) }

// 显式覆盖 Bark 字段，确保设置响应从不携带设备密钥。
func (n NotificationSettings) Public() any {
	return struct {
		NotificationSettings
		Bark any `json:"bark"`
	}{n, struct {
		ServerURL string `json:"serverURL"`
		HasKey    bool   `json:"hasKey"`
	}{n.Bark.ServerURL, n.Bark.DeviceKey != ""}}
}
