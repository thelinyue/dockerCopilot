package management

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
	_ "time/tzdata"

	docker "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/onlyLTY/dockerCopilot/internal/module"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/onlyLTY/dockerCopilot/internal/utiles"
	"github.com/robfig/cron/v3"
	"github.com/zeromicro/go-zero/core/logx"
	"github.com/zeromicro/go-zero/rest/token"
)

type Manager struct {
	Context   *svc.ServiceContext
	mu        sync.Mutex
	cron      *cron.Cron
	checkJob  cron.EntryID
	updateJob cron.EntryID
	parser    *token.TokenParser
}

func New(s *svc.ServiceContext) *Manager {
	return &Manager{Context: s, cron: cron.New(cron.WithParser(node.CronParser)), parser: token.NewTokenParser()}
}
func (m *Manager) Start() {
	m.ReloadSchedules()
	m.cron.Start()
	if m.Context.Settings.Get().StartupCheck {
		m.launch("启动检测", m.Check)
	}
}
func (m *Manager) Stop() { <-m.cron.Stop().Done() }
func (m *Manager) launch(name string, fn func(context.Context, string) error) {
	_, err := m.Context.RunTask(name, func(id string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Minute)
		defer cancel()
		return fn(ctx, id)
	})
	if err != nil {
		logx.Infof("%s 已跳过：%s", name, err)
	}
}
func (m *Manager) ReloadSchedules() {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.Context.Settings.Get()
	m.cron.Remove(m.checkJob)
	m.cron.Remove(m.updateJob)
	m.checkJob, _ = m.cron.AddFunc(s.CheckCron, func() { m.launch("定时检测", m.Check) })
	if s.AutoUpdate {
		m.updateJob, _ = m.cron.AddFunc(s.UpdateCron, func() { m.launch("定时自动更新", m.AutoUpdate) })
	}
}
func (m *Manager) NextRuns() map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	return map[string]any{"check": m.cron.Entry(m.checkJob).Next, "update": m.cron.Entry(m.updateJob).Next, "timezone": time.Local.String()}
}
func (m *Manager) message(id string, percent int, text string) {
	p, _ := m.Context.GetProgress(id)
	p.Percentage = percent
	p.Message = text
	m.Context.UpdateProgress(id, p)
}

func isCopilot(v docker.ContainerJSON) bool {
	if v.Config == nil {
		return true
	}
	hostname, _ := os.Hostname()
	return (len(hostname) >= 12 && strings.HasPrefix(v.ID, hostname)) || strings.Contains(strings.ToLower(v.Config.Image), "dockercopilot") || strings.Contains(strings.ToLower(v.Name), "dockercopilot")
}

func (m *Manager) checkContainer(ctx context.Context, v docker.ContainerJSON, imageRef string) module.ImageCheckList {
	result := module.ImageCheckList{CheckedAt: time.Now()}
	local, _, err := m.Context.DockerClient.ImageInspectWithRaw(ctx, v.Image)
	if err == nil {
		client := module.RegistryClient(m.Context.Settings.Get())
		defer client.CloseIdleConnections()
		result.NeedUpdate, err = module.CheckReference(ctx, client, imageRef, v.Image, local.Os, local.Architecture, local.Variant)
	}
	if err != nil {
		result.Error = err.Error()
	}
	m.Context.HubImageInfo.Set(v.ID, result)
	return result
}

func (m *Manager) Check(ctx context.Context, id string) error {
	list, err := m.Context.DockerClient.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return fmt.Errorf("连接 Docker 失败，请检查 socket 挂载: %w", err)
	}
	m.Context.HubImageInfo.Clear()
	failed, available := 0, 0
	cache := map[string]module.ImageCheckList{}
	for i, c := range list {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		v, err := m.Context.DockerClient.ContainerInspect(ctx, c.ID)
		if err != nil {
			failed++
			continue
		}
		key := v.Config.Image + "\n" + v.Image
		result, ok := cache[key]
		if !ok {
			result = m.checkContainer(ctx, v, v.Config.Image)
			cache[key] = result
		} else {
			m.Context.HubImageInfo.Set(v.ID, result)
		}
		if result.Error != "" {
			failed++
		}
		if result.NeedUpdate {
			available++
		}
		m.message(id, (i+1)*100/len(list), fmt.Sprintf("已检测 %d/%d 个容器，可更新 %d 个，无法确认 %d 个", i+1, len(list), available, failed))
	}
	p, _ := m.Context.GetProgress(id)
	p.DetailMsg = fmt.Sprintf("检测 %d 个容器，可更新 %d 个，无法确认 %d 个；具体原因见容器列表", len(list), available, failed)
	m.Context.UpdateProgress(id, p)
	if failed > 0 {
		return fmt.Errorf("检测完成，%d 个容器无法确认更新，请查看容器列表中的原因", failed)
	}
	return nil
}

func excluded(s node.Settings, v docker.ContainerJSON) bool {
	return node.Contains(s.ExcludedContainers, v.ID) || node.Contains(s.ExcludedContainers, strings.TrimPrefix(v.Name, "/"))
}

func (m *Manager) AutoUpdate(ctx context.Context, id string) error {
	s := m.Context.Settings.Get()
	list, err := m.Context.DockerClient.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return err
	}
	results := []string{}
	failures := 0
	for _, c := range list {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if c.Labels[projectLabel] != "" {
			continue
		}
		v, err := m.Context.DockerClient.ContainerInspect(ctx, c.ID)
		if err != nil {
			failures++
			continue
		}
		if excluded(s, v) || isCopilot(v) || !v.State.Running {
			results = append(results, v.Name+": 已跳过（排除、停止或程序自身）")
			continue
		}
		if err := utiles.CanRecreate(v); err != nil {
			results = append(results, v.Name+": 已跳过，"+err.Error())
			continue
		}
		checked := m.checkContainer(ctx, v, v.Config.Image)
		if checked.Error != "" {
			failures++
			results = append(results, v.Name+": 无法确认，"+checked.Error)
			continue
		}
		if !checked.NeedUpdate {
			results = append(results, v.Name+": 已是最新镜像")
			continue
		}
		if err := utiles.UpdateContainer(m.Context, v.ID, v.Name, v.Config.Image, os.Getenv("DelOldContainer") != "false", id); err != nil {
			failures++
			results = append(results, v.Name+": "+err.Error())
		} else {
			results = append(results, v.Name+": 已更新")
		}
	}
	projects, projectErr := m.Projects(ctx)
	if projectErr != nil {
		results = append(results, "项目扫描: "+projectErr.Error())
	}
	for _, p := range projects {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if len(p.Services) == 0 {
			continue
		}
		if p.Error != "" {
			results = append(results, p.Name+": 已跳过，"+p.Error)
			continue
		}
		model, err := m.model(ctx, p)
		if err != nil {
			results = append(results, p.Name+": 无法校验，"+err.Error())
			failures++
			continue
		}
		selected := []string{}
		for _, service := range p.Services {
			key := p.ID + "/" + service.Name
			if node.Contains(s.ExcludedServices, key) || service.Running == 0 || service.Running != service.Total {
				results = append(results, p.Name+"/"+service.Name+": 已跳过（排除或包含停止副本）")
				continue
			}
			target, exists := model.Services[service.Name]
			if !exists || target.Image == "" {
				results = append(results, p.Name+"/"+service.Name+": 已跳过（配置无可拉取镜像）")
				continue
			}
			allowed, needsUpdate := true, false
			replicas := []docker.ContainerJSON{}
			// 先检查所有副本的排除和重建条件，避免未排除副本先发起检测，掩盖整个服务应跳过的原因。
			for _, containerID := range service.Containers {
				v, err := m.Context.DockerClient.ContainerInspect(ctx, containerID)
				if err != nil {
					allowed = false
					failures++
					break
				}
				if excluded(s, v) || isCopilot(v) {
					allowed = false
					break
				}
				if err := utiles.CanRecreate(v); err != nil {
					allowed = false
					break
				}
				replicas = append(replicas, v)
			}
			if !allowed {
				results = append(results, p.Name+"/"+service.Name+": 已跳过（副本被排除、程序自身或无法可靠重建）")
				continue
			}
			for _, v := range replicas {
				checked := m.checkContainer(ctx, v, target.Image)
				if checked.Error != "" {
					allowed = false
					failures++
					results = append(results, p.Name+"/"+service.Name+": "+checked.Error)
					break
				}
				needsUpdate = needsUpdate || checked.NeedUpdate
			}
			if allowed && needsUpdate {
				selected = append(selected, service.Name)
			} else {
				results = append(results, p.Name+"/"+service.Name+": 无更新或不满足自动更新条件")
			}
		}
		if len(selected) == 0 {
			continue
		}
		if err := m.ComposeAction(ctx, p, "update", selected, id, true); err != nil {
			failures++
			results = append(results, p.Name+": "+err.Error())
		} else {
			results = append(results, p.Name+": 已更新 "+strings.Join(selected, ", "))
		}
	}
	p, _ := m.Context.GetProgress(id)
	p.DetailMsg = strings.Join(results, "\n")
	if failures > 0 && p.Status != "rollback_failed" {
		p.Status = "failed"
	}
	m.Context.UpdateProgress(id, p)
	if failures > 0 {
		return fmt.Errorf("自动更新完成，%d 项失败或无法确认，请查看任务详情", failures)
	}
	return nil
}
