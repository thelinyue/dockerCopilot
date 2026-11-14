package node

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/robfig/cron/v3"
)

type Settings struct {
	CheckCron          string   `json:"checkCron"`
	StartupCheck       bool     `json:"startupCheck"`
	AutoUpdate         bool     `json:"autoUpdate"`
	UpdateCron         string   `json:"updateCron"`
	ExcludedContainers []string `json:"excludedContainers"`
	ExcludedServices   []string `json:"excludedServices"`
	HTTPProxy          string   `json:"httpProxy"`
	HTTPSProxy         string   `json:"httpsProxy"`
}

var CronParser = cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)

type Store struct {
	mu       sync.RWMutex
	path     string
	settings Settings
}

func DataDir() string {
	if dir := os.Getenv("DATA_DIR"); dir != "" {
		return dir
	}
	return "/data"
}

func OpenSettings(dir string) (*Store, error) {
	s := &Store{path: filepath.Join(dir, "settings.json"), settings: Settings{
		CheckCron: "30 * * * *", StartupCheck: true, UpdateCron: "0 3 * * *",
		HTTPProxy: os.Getenv("HTTP_PROXY"), HTTPSProxy: os.Getenv("HTTPS_PROXY"),
		ExcludedContainers: []string{}, ExcludedServices: []string{},
	}}
	b, err := os.ReadFile(s.path)
	missing := os.IsNotExist(err)
	if err == nil {
		err = json.Unmarshal(b, &s.settings)
	} else if os.IsNotExist(err) {
		err = nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取节点设置失败，请检查 %s: %w", s.path, err)
	}
	if err = Validate(s.settings); err != nil {
		return nil, err
	}
	if missing {
		if err := WriteJSON(s.path, s.settings); err != nil {
			return nil, fmt.Errorf("初始化节点设置失败，请检查数据目录权限: %w", err)
		}
	}
	return s, nil
}

func Validate(s Settings) error {
	for _, value := range []string{s.CheckCron, s.UpdateCron} {
		if len(strings.Fields(value)) != 5 {
			return fmt.Errorf("定时表达式必须为五段 Cron，时区由设备 TZ 设置")
		}
		if _, err := CronParser.Parse(value); err != nil {
			return fmt.Errorf("定时表达式无效，请使用五段 Cron: %w", err)
		}
	}
	for _, value := range []string{s.HTTPProxy, s.HTTPSProxy} {
		if value == "" {
			continue
		}
		u, err := url.Parse(value)
		if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "socks5" && u.Scheme != "socks5h") || u.RawQuery != "" || u.Fragment != "" {
			return fmt.Errorf("代理地址无效，请使用 http://主机:端口、https://主机:端口或 socks5://主机:端口")
		}
	}
	return nil
}

func (s *Store) Get() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v := s.settings
	v.ExcludedContainers = append([]string{}, v.ExcludedContainers...)
	v.ExcludedServices = append([]string{}, v.ExcludedServices...)
	return v
}

func (s *Store) Save(v Settings) error {
	if err := Validate(v); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := WriteJSON(s.path, v); err != nil {
		return err
	}
	s.settings = v
	return nil
}

// 原子替换设置文件，凭据只对当前用户可读；失败时保留原文件。
func WriteJSON(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".settings-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

func RedactProxy(value string) string {
	u, err := url.Parse(value)
	if err != nil {
		return ""
	}
	if u.User != nil {
		u.User = url.UserPassword(u.User.Username(), "********")
	}
	return u.String()
}

func Contains(values []string, value string) bool {
	for _, v := range values {
		if strings.TrimSpace(v) == value {
			return true
		}
	}
	return false
}
