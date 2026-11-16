package management

import (
	"context"
	"fmt"
	"strings"

	docker "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/notify"
	"github.com/onlyLTY/dockerCopilot/internal/svc"
	"github.com/onlyLTY/dockerCopilot/internal/utiles"
)

func (m *Manager) AutoUpdate(ctx context.Context, id string) error {
	run := newCheckRun()
	if err := m.checkAll(ctx, id, run, 10); err != nil {
		return err
	}
	m.message(id, 10, "检测完成，正在按本次结果检查自动更新条件")
	list, err := m.Context.DockerClient.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return err
	}
	results, failures := []string{run.summary()}, 0
	for _, c := range list {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if c.Labels[projectLabel] != "" {
			continue
		}
		line, err := m.autoUpdateContainer(ctx, id, c.ID, run)
		results = append(results, line)
		if err != nil {
			failures++
		}
	}
	projects, err := m.Projects(ctx)
	if err != nil {
		results = append(results, "项目扫描: "+err.Error())
		m.Context.RecordNotice(id, notify.Result{Key: "project-scan", Object: "项目扫描", Kind: notify.CheckFailed})
		failures++
	}
	for _, project := range projects {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if len(project.Services) == 0 {
			continue
		}
		lines, err := m.autoUpdateProject(ctx, id, project, run)
		results = append(results, lines...)
		if err != nil {
			failures++
		}
	}
	p, _ := m.Context.GetProgress(id)
	p.DetailMsg = strings.Join(results, "\n")
	if (failures > 0 || run.failed > 0) && p.Status != "rollback_failed" {
		p.Status = "failed"
	}
	m.Context.UpdateProgress(id, p)
	if failures > 0 || run.failed > 0 {
		return fmt.Errorf("检测并更新完成，检测 %d 项无法确认、更新 %d 项失败或无法确认，请查看任务详情", run.failed, failures)
	}
	return nil
}

func (m *Manager) finishAutoObject(id string, release func()) {
	m.Context.TaskResource(id, nil, "auto-update")
	release()
	m.Context.CleanupTaskImages(id)
}

func (m *Manager) autoUpdateContainer(ctx context.Context, id, containerID string, run *checkRun) (line string, taskErr error) {
	notice := notify.Result{ID: containerID, Key: "container:" + containerID, Object: containerID, Kind: notify.CheckFailed}
	updating := false
	defer func() {
		// 进入重建流程前的读取失败也要保留对象；重建及恢复结果由更新流程记录。
		if taskErr != nil && !updating {
			m.Context.RecordNotice(id, notice)
		}
	}()
	v, release, err := m.Context.AcquireContainer(ctx, containerID, "")
	if err != nil {
		if svc.IsBusy(err) {
			return containerID + ": 已跳过，" + err.Error(), nil
		}
		return containerID + ": " + err.Error(), err
	}
	notice = svc.ContainerNotice(v)
	notice.Kind = notify.CheckFailed
	m.Context.TaskResource(id, svc.ContainerScope(v).Resource, "update")
	defer m.finishAutoObject(id, release)
	s := m.Context.Settings.Get()
	// 在持锁后读取的实际状态上作决定，不沿用扫描开始时的运行状态。
	current, err := m.Context.DockerClient.ContainerInspect(ctx, v.ID)
	if err != nil {
		return v.Name + ": 无法确认容器状态", err
	}
	v = current
	if v.Config == nil || v.State == nil {
		return v.Name + ": 容器配置不完整", fmt.Errorf("容器配置不完整")
	}
	if v.Config.Labels[projectLabel] != "" || excluded(s, v) || isCopilot(v) || !v.State.Running {
		return v.Name + ": 已跳过（项目容器、排除、停止或程序自身）", nil
	}
	if err := utiles.CanRecreate(v); err != nil {
		return v.Name + ": 已跳过，" + err.Error(), nil
	}
	if !run.unchanged(v) {
		m.Context.ForgetAvailable(id, svc.ContainerNotice(v).Key)
		return v.Name + ": 已跳过（容器在本次检测后已变化或未能确认，请重新执行）", nil
	}
	checked, currentCheck := m.checkContainer(ctx, v, v.Config.Image, run)
	if !currentCheck {
		m.Context.ForgetAvailable(id, svc.ContainerNotice(v).Key)
		return v.Name + ": 已跳过（检测期间容器已变化）", nil
	}
	if checked.Error != "" {
		return v.Name + ": 无法确认，" + checked.Error, fmt.Errorf("%s", checked.Error)
	}
	if !checked.NeedUpdate {
		return v.Name + ": 已是最新镜像", nil
	}
	updating = true
	if err := utiles.UpdateContainer(m.Context, v.ID, v.Name, v.Config.Image, !s.KeepOldContainer, id); err != nil {
		return v.Name + ": " + err.Error(), err
	}
	return v.Name + ": 已更新", nil
}

func (m *Manager) autoUpdateProject(ctx context.Context, id string, project Project, run *checkRun) ([]string, error) {
	scope := svc.ProjectScope(project.Name, project.Directory)
	release, err := m.Context.Acquire(scope)
	if err != nil {
		return []string{project.Name + ": 已跳过，" + err.Error()}, nil
	}
	m.Context.TaskResource(id, scope.Resource, "update")
	defer m.finishAutoObject(id, release)
	p, err := m.Project(ctx, project.ID)
	if err != nil {
		m.Context.RecordNotice(id, notify.Result{Key: "project:" + project.Name, Object: project.Name, Kind: notify.CheckFailed})
		return []string{project.Name + ": 无法校验，" + err.Error()}, err
	}
	s := m.Context.Settings.Get()
	results, eligible := []string{}, []Service{}
	for _, service := range p.Services {
		if node.Contains(s.ExcludedServices, p.ID+"/"+service.Name) || service.Running == 0 || service.Running != service.Total {
			results = append(results, p.Name+"/"+service.Name+": 已跳过（排除或包含停止副本）")
		} else {
			eligible = append(eligible, service)
		}
	}
	if len(eligible) == 0 {
		return results, nil
	}
	model, err := m.model(ctx, p)
	if err != nil {
		m.Context.RecordNotice(id, notify.Result{Key: "project:" + p.Name, Object: p.Name, Kind: notify.CheckFailed})
		return append(results, p.Name+": 无法校验，"+err.Error()), err
	}
	selected, failures := []string{}, 0
	for _, service := range eligible {
		target, exists := model.Services[service.Name]
		if !exists || target.Image == "" {
			results = append(results, p.Name+"/"+service.Name+": 已跳过（配置无可拉取镜像）")
			continue
		}
		allowed, needsUpdate := true, false
		replicas := []docker.ContainerJSON{}
		// 所有副本满足条件后才检测；单个停止或排除的副本会阻止整个服务更新。
		for _, containerID := range service.Containers {
			v, err := m.Context.DockerClient.ContainerInspect(ctx, containerID)
			if err != nil {
				m.Context.RecordNotice(id, notify.Result{ID: containerID, Key: "service:" + p.Name + "/" + service.Name, Object: p.Name + "/" + service.Name, Image: target.Image, Kind: notify.CheckFailed})
				allowed = false
				failures++
				break
			}
			if v.Config == nil || v.State == nil || !v.State.Running || excluded(s, v) || isCopilot(v) || !run.unchanged(v) {
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
			results = append(results, p.Name+"/"+service.Name+": 已跳过（副本停止、被排除、状态已变化、程序自身或无法可靠重建）")
			continue
		}
		for _, v := range replicas {
			checked, currentCheck := m.checkContainer(ctx, v, target.Image, run)
			if !currentCheck {
				allowed = false
				break
			}
			if checked.Error != "" {
				notice := svc.ContainerNotice(v)
				notice.Image, notice.Kind = target.Image, notify.CheckFailed
				m.Context.RecordNotice(id, notice)
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
	if len(selected) > 0 {
		if err := m.ComposeAction(ctx, p, "update", selected, id, true); err != nil {
			results = append(results, p.Name+": "+err.Error())
			failures++
		} else {
			results = append(results, p.Name+": 已更新 "+strings.Join(selected, ", "))
		}
	}
	if failures > 0 {
		return results, fmt.Errorf("%d 个服务失败或无法确认", failures)
	}
	return results, nil
}
