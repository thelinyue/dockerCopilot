package management

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/onlyLTY/dockerCopilot/internal/config"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/onlyLTY/dockerCopilot/internal/types"
	"github.com/zeromicro/go-zero/rest"
	"github.com/zeromicro/go-zero/rest/httpx"
	"github.com/zeromicro/go-zero/rest/pathvar"
)

func reply(w http.ResponseWriter, data any, err error) {
	if err != nil {
		status := http.StatusBadRequest
		if svc.IsBusy(err) {
			status = http.StatusConflict
		}
		httpx.WriteJson(w, status, types.Resp{Code: status, Msg: err.Error()})
		return
	}
	httpx.OkJson(w, types.Resp{Code: 200, Msg: "操作成功", Data: data})
}
func decode(w http.ResponseWriter, r *http.Request, value any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
	if err := json.NewDecoder(r.Body).Decode(value); err != nil {
		return fmt.Errorf("请求格式无效或内容超过大小限制")
	}
	return nil
}

// 仅注册业务路由进入包装器；先认证再选择设备，不允许转发绕过本机认证。
func (m *Manager) Wrap(next http.HandlerFunc) http.HandlerFunc {
	return RequestLog(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		if !strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/api/auth" {
			next(w, r)
			return
		}
		var ok bool
		r, ok = m.authorize(w, r)
		if !ok {
			return
		}
		deviceID := r.Header.Get(node.DeviceHeader)
		if strings.HasPrefix(r.URL.Path, "/api/devices") {
			if deviceID != "" && deviceID != "local" {
				reply(w, nil, fmt.Errorf("设备列表由主容器管理，请切回本机"))
				return
			}
			next(w, r)
			return
		}
		if deviceID != "" && deviceID != "local" {
			device, ok := m.Context.Devices.Find(deviceID)
			if !ok {
				reply(w, nil, fmt.Errorf("设备不存在，请重新选择"))
				return
			}
			body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<20))
			if err != nil {
				reply(w, nil, fmt.Errorf("请求内容超过 16 MiB"))
				return
			}
			path := r.URL.EscapedPath()
			if r.URL.RawQuery != "" {
				path += "?" + r.URL.RawQuery
			}
			resp, err := m.Context.Devices.Request(device, r.Method, path, body, r.Header)
			if err != nil {
				httpx.WriteJson(w, 502, types.Resp{Code: 502, Msg: err.Error()})
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode == 401 {
				httpx.WriteJson(w, 502, types.Resp{Code: 502, Msg: "远端认证失败，请检查设备密钥"})
				return
			}
			for _, name := range []string{"Content-Type", "Content-Disposition"} {
				if value := resp.Header.Get(name); value != "" {
					w.Header().Set(name, value)
				}
			}
			w.WriteHeader(resp.StatusCode)
			io.Copy(w, resp.Body)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/image/") {
			release, err := m.Context.Acquire(svc.OperationScope{})
			if err != nil {
				reply(w, nil, err)
				return
			}
			defer release()
		} else if strings.HasPrefix(r.URL.Path, "/api/container/") && r.Method != http.MethodGet && !strings.HasSuffix(r.URL.Path, "/update") {
			_, release, err := m.Context.AcquireContainer(r.Context(), pathvar.Vars(r)["id"], r.URL.Query().Get("newName"))
			if err != nil {
				reply(w, nil, err)
				return
			}
			defer release()
		}
		next(w, r)
	})
}

func (m *Manager) Routes(server *rest.Server) {
	routes := []rest.Route{}
	add := func(method, path string, handler http.HandlerFunc) {
		routes = append(routes, rest.Route{Method: method, Path: path, Handler: m.Wrap(handler)})
	}
	add("POST", "/image/prune", m.pruneImages)
	add("GET", "/node/info", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		b, err := exec.CommandContext(ctx, "docker", "compose", "version", "--short").Output()
		reply(w, map[string]any{"version": config.Version, "buildDate": config.BuildDate, "composeVersion": strings.TrimSpace(string(b)), "composeRoot": ComposeRoot(), "capabilities": map[string]bool{"compose": err == nil, "composeEditing": true, "schedules": true, "devices": true}}, nil)
	})
	add("GET", "/settings", func(w http.ResponseWriter, r *http.Request) {
		s := m.Context.Settings.Get()
		s.HTTPProxy = node.RedactProxy(s.HTTPProxy)
		s.HTTPSProxy = node.RedactProxy(s.HTTPSProxy)
		reply(w, map[string]any{"settings": s, "nextRuns": m.NextRuns()}, nil)
	})
	add("PUT", "/settings", func(w http.ResponseWriter, r *http.Request) {
		s := m.Context.Settings.Get()
		previous := s
		err := decode(w, r, &s)
		if err == nil {
			if s.HTTPProxy == node.RedactProxy(previous.HTTPProxy) {
				s.HTTPProxy = previous.HTTPProxy
			}
			if s.HTTPSProxy == node.RedactProxy(previous.HTTPSProxy) {
				s.HTTPSProxy = previous.HTTPSProxy
			}
			err = m.Context.Settings.Save(s)
		}
		if err == nil {
			m.ReloadSchedules()
			m.Context.HubImageInfo.Clear()
		}
		reply(w, nil, err)
	})
	add("GET", "/tasks", func(w http.ResponseWriter, r *http.Request) { reply(w, m.Context.Tasks(), nil) })
	for _, item := range []struct {
		path, name string
		fn         func(context.Context, string) error
		job        string
	}{{"/checks", "手动检测", m.Check, "check"}, {"/auto-update", "手动检测并更新", m.AutoUpdate, "auto-update"}} {
		item := item
		add("POST", item.path, func(w http.ResponseWriter, r *http.Request) {
			id, err := m.Context.RunTask(item.name, svc.OperationScope{Job: "automation"}, item.job, func(id string) error {
				ctx, cancel := context.WithTimeout(context.Background(), time.Hour)
				defer cancel()
				return item.fn(ctx, id)
			})
			reply(w, map[string]string{"taskID": id}, err)
		})
	}
	add("GET", "/compose/projects", func(w http.ResponseWriter, r *http.Request) {
		p, err := m.Projects(r.Context())
		if len(p) > 0 && err != nil {
			reply(w, map[string]any{"projects": p, "warning": err.Error()}, nil)
		} else {
			reply(w, map[string]any{"projects": p}, err)
		}
	})
	add("POST", "/compose/projects", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			Name  string   `json:"name"`
			Files []string `json:"files"`
		}
		if err := decode(w, r, &v); err != nil {
			reply(w, nil, err)
			return
		}
		p, err := m.ImportProject(v.Name, v.Files)
		reply(w, p, err)
	})
	add("GET", "/compose/projects/:id/files/:index", func(w http.ResponseWriter, r *http.Request) {
		vars := pathvar.Vars(r)
		index, err := strconv.Atoi(vars["index"])
		if err != nil {
			reply(w, nil, fmt.Errorf("文件索引无效"))
			return
		}
		content, err := m.ReadFile(r.Context(), vars["id"], index)
		reply(w, map[string]string{"content": content}, err)
	})
	add("PUT", "/compose/projects/:id/files/:index", func(w http.ResponseWriter, r *http.Request) {
		vars := pathvar.Vars(r)
		index, err := strconv.Atoi(vars["index"])
		if err != nil {
			reply(w, nil, fmt.Errorf("文件索引无效"))
			return
		}
		var v struct {
			Original string `json:"original"`
			Content  string `json:"content"`
		}
		if err = decode(w, r, &v); err == nil {
			err = m.SaveFile(r.Context(), vars["id"], index, v.Original, v.Content)
		}
		reply(w, nil, err)
	})
	add("POST", "/compose/projects/:id/files/:index/validate", func(w http.ResponseWriter, r *http.Request) {
		vars := pathvar.Vars(r)
		index, err := strconv.Atoi(vars["index"])
		if err != nil {
			reply(w, nil, fmt.Errorf("文件索引无效，请重新选择配置文件"))
			return
		}
		var v struct {
			Content string `json:"content"`
		}
		if err := decode(w, r, &v); err != nil {
			reply(w, nil, err)
			return
		}
		result, err := m.ValidateFile(r.Context(), vars["id"], index, v.Content)
		reply(w, result, err)
	})
	add("POST", "/compose/projects/:id/actions", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			Action   string   `json:"action"`
			Services []string `json:"services"`
		}
		if err := decode(w, r, &v); err != nil {
			reply(w, nil, err)
			return
		}
		p, err := m.Project(r.Context(), pathvar.Vars(r)["id"])
		if err != nil {
			reply(w, nil, err)
			return
		}
		if !node.Contains([]string{"validate", "start", "stop", "restart", "pull", "deploy", "update"}, v.Action) {
			reply(w, nil, fmt.Errorf("不支持的操作"))
			return
		}
		id, err := m.Context.RunTask("项目 "+p.Name+" · "+composeOperationNames[v.Action], svc.ProjectScope(p.Name, p.Directory), v.Action, func(id string) error {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
			defer cancel()
			current, err := m.Project(ctx, p.ID)
			if err != nil {
				return err
			}
			return m.ComposeAction(ctx, current, v.Action, v.Services, id, v.Action == "update")
		})
		reply(w, map[string]string{"taskID": id}, err)
	})
	add("GET", "/icon-file", func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("name")
		if name == "" || name != filepath.Base(name) || strings.ContainsAny(name, `/\\`) {
			reply(w, nil, fmt.Errorf("图标文件名无效"))
			return
		}
		path := filepath.Join("/data/config/image", name)
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, path)
	})
	add("GET", "/devices", func(w http.ResponseWriter, r *http.Request) { reply(w, m.Context.Devices.List(), nil) })
	saveDevice := func(w http.ResponseWriter, r *http.Request) {
		var v node.Device
		if err := decode(w, r, &v); err != nil {
			reply(w, nil, err)
			return
		}
		v.ID = pathvar.Vars(r)["id"]
		device, err := m.Context.Devices.Save(v)
		if err != nil {
			reply(w, nil, err)
			return
		}
		stored, _ := m.Context.Devices.Find(device.ID)
		_, connectionErr := m.Context.Devices.Info(stored)
		warning := ""
		if connectionErr != nil {
			warning = connectionErr.Error()
		}
		reply(w, map[string]any{"device": device, "warning": warning}, nil)
	}
	add("POST", "/devices", saveDevice)
	add("PUT", "/devices/:id", saveDevice)
	add("DELETE", "/devices/:id", func(w http.ResponseWriter, r *http.Request) {
		reply(w, nil, m.Context.Devices.Delete(pathvar.Vars(r)["id"]))
	})
	add("POST", "/devices/:id/test", func(w http.ResponseWriter, r *http.Request) {
		v, ok := m.Context.Devices.Find(pathvar.Vars(r)["id"])
		if !ok {
			reply(w, nil, fmt.Errorf("设备不存在"))
			return
		}
		info, err := m.Context.Devices.Info(v)
		reply(w, info, err)
	})
	server.AddRoutes(routes, rest.WithPrefix("/api"), rest.WithMaxBytes(16<<20))
}
