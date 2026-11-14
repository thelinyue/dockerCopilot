package management

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	docker "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/onlyLTY/dockerCopilot/internal/node"
	"github.com/onlyLTY/dockerCopilot/internal/utiles"
	"gopkg.in/yaml.v3"
)

const projectLabel = "com.docker.compose.project"
const serviceLabel = "com.docker.compose.service"
const maxComposeSize = 2 << 20

var composeOperationNames = map[string]string{"validate": "检查配置", "config": "检查配置", "start": "启动", "stop": "停止", "restart": "重启", "pull": "拉取镜像", "deploy": "部署", "up": "部署", "update": "更新"}

type Project struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Directory string    `json:"directory"`
	Files     []string  `json:"files"`
	Services  []Service `json:"services"`
	Error     string    `json:"error,omitempty"`
}
type Service struct {
	Name       string   `json:"name"`
	Containers []string `json:"containers"`
	Running    int      `json:"running"`
	Total      int      `json:"total"`
}
type composeModel struct {
	Services map[string]struct {
		Image string `json:"image"`
	} `json:"services"`
}

func ComposeRoot() string {
	root := os.Getenv("COMPOSE_ROOT")
	if root == "" {
		root = "/compose"
	}
	return filepath.Clean(root)
}

// 容器标签中的工作目录与配置文件分别校验；绝对 -f 路径不能替代项目目录的边界检查。
func resolveDirectory(root, dir string) error {
	if !filepath.IsAbs(root) || !filepath.IsAbs(dir) {
		return fmt.Errorf("项目根目录和工作目录必须为绝对路径")
	}
	rel, err := filepath.Rel(root, dir)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("项目工作目录超出 COMPOSE_ROOT，请检查目录挂载")
	}
	current := root
	for _, part := range append([]string{"."}, strings.Split(rel, string(filepath.Separator))...) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return fmt.Errorf("无法读取项目工作目录，请检查挂载: %w", err)
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("项目工作目录包含符号链接或不是普通目录，拒绝访问")
		}
	}
	return nil
}

// 文件入口统一锚定挂载根目录；逐段拒绝符号链接，禁止把编辑权限扩展到其他宿主机文件。
func resolveFile(root, path string) (string, fs.FileInfo, error) {
	if !filepath.IsAbs(root) {
		return "", nil, fmt.Errorf("COMPOSE_ROOT 必须为绝对路径")
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(root, path)
	}
	path = filepath.Clean(path)
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", nil, fmt.Errorf("文件超出 COMPOSE_ROOT，拒绝访问")
	}
	parts := append([]string{"."}, strings.Split(rel, string(filepath.Separator))...)
	current := root
	var info fs.FileInfo
	for _, part := range parts {
		current = filepath.Join(current, part)
		info, err = os.Lstat(current)
		if err != nil {
			return "", nil, fmt.Errorf("无法读取项目路径，请检查目录挂载: %w", err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", nil, fmt.Errorf("项目路径包含符号链接，拒绝编辑或部署")
		}
	}
	if !info.Mode().IsRegular() || info.Size() > maxComposeSize {
		return "", nil, fmt.Errorf("只支持不超过 2 MiB 的普通项目配置文件")
	}
	ext := strings.ToLower(filepath.Ext(path))
	if ext != ".yml" && ext != ".yaml" && ext != ".json" {
		return "", nil, fmt.Errorf("只支持 YAML、YML 或 JSON 配置")
	}
	return path, info, nil
}

func projectID(name, dir string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(name + "\n" + dir))
}
func projectFromFiles(name, dir string, files []string) Project {
	return Project{ID: projectID(name, dir), Name: name, Directory: dir, Files: files, Services: []Service{}}
}

var projectNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

func defaultProjectName(dir string) string {
	name := regexp.MustCompile(`[^a-z0-9_-]`).ReplaceAllString(strings.ToLower(filepath.Base(dir)), "")
	name = strings.TrimLeft(name, "_-")
	if name == "" {
		name = "project"
	}
	return name
}

func (m *Manager) Projects(ctx context.Context) ([]Project, error) {
	projects := map[string]Project{}
	// 标签保留原部署的文件顺序及非常规文件名（例如 deployment.json）。
	containers, dockerErr := m.Context.DockerClient.ContainerList(ctx, container.ListOptions{All: true, Filters: filters.NewArgs(filters.Arg("label", projectLabel))})
	for _, c := range containers {
		name, dir := c.Labels[projectLabel], c.Labels["com.docker.compose.project.working_dir"]
		files := strings.Split(c.Labels["com.docker.compose.project.config_files"], ",")
		id := projectID(name, dir)
		p, ok := projects[id]
		if !ok {
			p = projectFromFiles(name, dir, files)
		}
		service := c.Labels[serviceLabel]
		index := -1
		for i := range p.Services {
			if p.Services[i].Name == service {
				index = i
			}
		}
		if index < 0 {
			p.Services = append(p.Services, Service{Name: service, Containers: []string{}})
			index = len(p.Services) - 1
		}
		p.Services[index].Total++
		if c.State == "running" {
			p.Services[index].Running++
		}
		p.Services[index].Containers = append(p.Services[index].Containers, c.ID)
		projects[id] = p
	}
	root := ComposeRoot()
	// 自选文件记录只含项目位置，不存储 Compose 文件副本。
	var imported []Project
	if b, err := os.ReadFile(filepath.Join(node.DataDir(), "compose-projects.json")); err == nil {
		if err := json.Unmarshal(b, &imported); err != nil {
			return nil, fmt.Errorf("读取接管项目记录失败: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	for _, p := range imported {
		if running, ok := projects[p.ID]; ok {
			p.Services = running.Services
		} else {
			p.Services = []Service{}
		}
		projects[p.ID] = p
	}
	seen := map[string]bool{}
	for _, p := range projects {
		for _, f := range p.Files {
			if !filepath.IsAbs(f) {
				f = filepath.Join(p.Directory, f)
			}
			seen[filepath.Clean(f)] = true
		}
	}
	entries := 0
	walkErr := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		entries++
		if entries > 20000 {
			return fmt.Errorf("目录项目较多，自动扫描已达到上限，请通过文件路径接管项目")
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if entry.IsDir() {
			rel, _ := filepath.Rel(root, path)
			// 自动发现只扫描根目录和一级项目目录，避免把升级备份及应用数据中的配置识别为新项目。
			// 深层真实项目仍由容器标签或显式接管记录发现，不依赖目录扫描。
			if strings.Count(rel, string(filepath.Separator)) >= 1 {
				return filepath.SkipDir
			}
			return nil
		}
		if seen[path] {
			return nil
		}
		base := filepath.Base(path)
		if base != "compose.yaml" && base != "compose.yml" && base != "docker-compose.yaml" && base != "docker-compose.yml" {
			return nil
		}
		dir := filepath.Dir(path)
		// 同目录只自动选择一套主配置；其他配置可通过接管入口指定顺序。
		for _, p := range projects {
			if p.Directory == dir {
				return nil
			}
		}
		files := []string{path}
		for _, suffix := range []string{".yaml", ".yml"} {
			prefix := "compose.override"
			if strings.HasPrefix(base, "docker-") {
				prefix = "docker-compose.override"
			}
			override := filepath.Join(dir, prefix+suffix)
			if _, _, err := resolveFile(root, override); err == nil {
				files = append(files, override)
				break
			}
		}
		name := defaultProjectName(dir)
		if b, err := readComposeFile(root, path); err == nil {
			var v struct {
				Name string `yaml:"name"`
			}
			if yaml.Unmarshal(b, &v) == nil && projectNamePattern.MatchString(v.Name) {
				name = v.Name
			}
		}
		p := projectFromFiles(name, dir, files)
		projects[p.ID] = p
		return nil
	})
	result := make([]Project, 0, len(projects))
	nameDirectories := map[string]map[string]bool{}
	for _, p := range projects {
		if nameDirectories[p.Name] == nil {
			nameDirectories[p.Name] = map[string]bool{}
		}
		nameDirectories[p.Name][p.Directory] = true
	}
	for _, p := range projects {
		if len(nameDirectories[p.Name]) > 1 {
			p.Error = "多个目录使用相同项目名，请使用唯一项目名接管后再操作，避免影响其他目录的服务"
		}
		if err := resolveDirectory(root, p.Directory); err != nil {
			p.Error = err.Error()
		}
		for i, f := range p.Files {
			if !filepath.IsAbs(f) {
				f = filepath.Join(p.Directory, f)
			}
			p.Files[i] = f
			if _, _, err := resolveFile(root, f); err != nil {
				p.Error = err.Error()
				break
			}
		}
		result = append(result, p)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name+result[i].Directory < result[j].Name+result[j].Directory })
	if len(result) == 0 {
		if walkErr != nil {
			return result, fmt.Errorf("无法扫描项目目录，请挂载并设置 COMPOSE_ROOT: %w", walkErr)
		}
		if dockerErr != nil {
			return result, dockerErr
		}
	}
	if walkErr != nil && !os.IsNotExist(walkErr) {
		return result, walkErr
	}
	return result, nil
}

func (m *Manager) Project(ctx context.Context, id string) (Project, error) {
	projects, err := m.Projects(ctx)
	for _, p := range projects {
		if p.ID == id {
			if p.Error != "" {
				return p, errors.New(p.Error)
			}
			return p, nil
		}
	}
	if err != nil {
		return Project{}, err
	}
	return Project{}, fmt.Errorf("项目不存在，请刷新项目列表")
}

func (m *Manager) ImportProject(name string, files []string) (Project, error) {
	if !m.Context.Operation.TryLock() {
		return Project{}, fmt.Errorf("本设备正在执行变更，请稍后接管")
	}
	defer m.Context.Operation.Unlock()
	if len(files) == 0 || len(files) > 20 {
		return Project{}, fmt.Errorf("请选择 1 至 20 个已有配置文件，按主文件、override 顺序填写")
	}
	for i, f := range files {
		path, _, err := resolveFile(ComposeRoot(), f)
		if err != nil {
			return Project{}, err
		}
		files[i] = path
	}
	dir := filepath.Dir(files[0])
	if name == "" {
		name = defaultProjectName(dir)
	}
	if !projectNamePattern.MatchString(name) {
		return Project{}, fmt.Errorf("项目名只能包含小写字母、数字、下划线和短横线，并以字母或数字开头")
	}
	p := projectFromFiles(name, dir, files)
	var items []Project
	path := filepath.Join(node.DataDir(), "compose-projects.json")
	if b, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(b, &items); err != nil {
			return p, err
		}
	} else if !os.IsNotExist(err) {
		return p, err
	}
	found := false
	for i := range items {
		if items[i].ID == p.ID {
			items[i] = p
			found = true
		}
	}
	if !found {
		items = append(items, p)
	}
	return p, node.WriteJSON(path, items)
}

func (m *Manager) ReadFile(ctx context.Context, id string, index int) (string, error) {
	p, err := m.Project(ctx, id)
	if err != nil {
		return "", err
	}
	if index < 0 || index >= len(p.Files) {
		return "", fmt.Errorf("文件索引无效")
	}
	path, _, err := resolveFile(ComposeRoot(), p.Files[index])
	if err != nil {
		return "", err
	}
	b, err := readComposeFile(ComposeRoot(), path)
	return string(b), err
}

func (m *Manager) SaveFile(ctx context.Context, id string, index int, original, content string) error {
	if !m.Context.Operation.TryLock() {
		return fmt.Errorf("本设备正在执行变更，请等待任务完成后保存")
	}
	defer m.Context.Operation.Unlock()
	p, err := m.Project(ctx, id)
	if err != nil {
		return err
	}
	if index < 0 || index >= len(p.Files) {
		return fmt.Errorf("文件索引无效")
	}
	path, _, err := resolveFile(ComposeRoot(), p.Files[index])
	if err != nil {
		return err
	}
	if err := validateSyntax(path, content); err != nil {
		return err
	}
	return writeComposeFile(ComposeRoot(), path, original, content)
}

type limitedOutput struct{ bytes.Buffer }

func (b *limitedOutput) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len() < 4<<20 {
		limit := (4 << 20) - b.Len()
		if len(p) > limit {
			p = p[:limit]
		}
		b.Buffer.Write(p)
	}
	return n, nil
}

func composeCommand(ctx context.Context, p Project, draftIndex int, content string, args ...string) (*exec.Cmd, error) {
	if err := resolveDirectory(ComposeRoot(), p.Directory); err != nil {
		return nil, err
	}
	argv := []string{"compose", "--ansi", "never", "-p", p.Name, "--project-directory", p.Directory}
	for index, f := range p.Files {
		if _, _, err := resolveFile(ComposeRoot(), f); err != nil {
			return nil, err
		}
		if index == draftIndex {
			f = "-"
		}
		argv = append(argv, "-f", f)
	}
	argv = append(argv, args...)
	cmd := exec.CommandContext(ctx, "docker", argv...)
	cmd.Dir = p.Directory
	if draftIndex >= 0 {
		// 用 stdin 替换当前文件，保留原有顺序和项目目录；检查草稿不落盘。
		cmd.Stdin = strings.NewReader(content)
	}
	return cmd, nil
}

func (m *Manager) compose(ctx context.Context, p Project, args ...string) ([]byte, error) {
	cmd, err := composeCommand(ctx, p, -1, "", args...)
	if err != nil {
		return nil, err
	}
	var stdout, stderr limitedOutput
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		// Compose 输出可能含环境变量值，不将原始 stderr 放进持久日志或任务错误。
		if errors.Is(err, exec.ErrNotFound) {
			return nil, fmt.Errorf("缺少 Docker CLI，请升级 DockerCopilot 容器镜像")
		}
		if ctx.Err() != nil {
			return nil, fmt.Errorf("项目操作超时或已中断，请检查执行结果后重试")
		}
		location := ""
		if match := yamlLine.FindStringSubmatch(stderr.String()); len(match) > 1 {
			location = "，第 " + match[1] + " 行"
		}
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return nil, fmt.Errorf("项目%s失败（退出码 %d%s），请检查项目语法、环境文件、挂载路径及宿主机 Docker 日志", composeOperationNames[args[0]], exit.ExitCode(), location)
		}
		return nil, fmt.Errorf("无法执行项目操作，请检查项目管理组件与文件权限")
	}
	return stdout.Bytes(), nil
}

func (m *Manager) model(ctx context.Context, p Project) (composeModel, error) {
	b, err := m.compose(ctx, p, "config", "--format", "json")
	if err != nil {
		return composeModel{}, err
	}
	var model composeModel
	err = json.Unmarshal(b, &model)
	if err != nil {
		return model, fmt.Errorf("无法解析项目配置输出，请检查项目管理组件版本")
	}
	return model, nil
}

func (m *Manager) projectContainers(ctx context.Context, p Project, selected []string) ([]docker.ContainerJSON, error) {
	list, err := m.Context.DockerClient.ContainerList(ctx, container.ListOptions{All: true, Filters: filters.NewArgs(filters.Arg("label", projectLabel+"="+p.Name))})
	if err != nil {
		return nil, err
	}
	result := []docker.ContainerJSON{}
	for _, c := range list {
		if c.Labels["com.docker.compose.project.working_dir"] != p.Directory {
			continue
		}
		if len(selected) > 0 && !node.Contains(selected, c.Labels[serviceLabel]) {
			continue
		}
		if c.Labels["com.docker.compose.oneoff"] == "True" {
			continue
		}
		v, err := m.Context.DockerClient.ContainerInspect(ctx, c.ID)
		if err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	return result, nil
}

func (m *Manager) ComposeAction(ctx context.Context, p Project, action string, selected []string, taskID string, preserveScale bool) error {
	model, err := m.model(ctx, p)
	if err != nil {
		return err
	}
	for _, s := range selected {
		if _, ok := model.Services[s]; !ok {
			return fmt.Errorf("配置中不存在服务 %s", s)
		}
	}
	if action == "validate" {
		return nil
	}
	if action == "start" || action == "stop" || action == "restart" || action == "pull" {
		_, err := m.compose(ctx, p, append([]string{action}, selected...)...)
		return err
	}
	if action != "deploy" && action != "update" {
		return fmt.Errorf("不支持的项目操作")
	}
	old, err := m.projectContainers(ctx, p, selected)
	if err != nil {
		return err
	}
	for _, v := range old {
		if err := utiles.CanRecreate(v); err != nil {
			return fmt.Errorf("%s: %w", v.Name, err)
		}
		if isCopilot(v) {
			return fmt.Errorf("请在宿主机升级 DockerCopilot 自身所属的项目")
		}
	}
	snapshotPath := filepath.Join(node.DataDir(), "recovery", taskID+".json")
	if err := node.WriteJSON(snapshotPath, old); err != nil {
		return err
	}
	pins := []string{}
	cleanup := true
	defer func() {
		if cleanup {
			for _, pin := range pins {
				m.Context.DockerClient.ImageRemove(context.Background(), pin, image.RemoveOptions{PruneChildren: false})
			}
			os.Remove(snapshotPath)
		}
	}()
	for i, v := range old {
		pin := "dockercopilot-recovery/" + taskID + ":" + strconv.Itoa(i)
		if err := m.Context.DockerClient.ImageTag(ctx, v.Image, pin); err != nil {
			return fmt.Errorf("保留旧镜像失败，尚未修改容器: %w", err)
		}
		pins = append(pins, pin)
	}
	if action == "update" {
		m.message(taskID, 15, "正在拉取项目镜像")
		if _, err := m.compose(ctx, p, append([]string{"pull", "--policy", "always"}, selected...)...); err != nil {
			return err
		}
	}
	args := []string{"up", "-d", "--no-build", "--no-deps", "--wait", "--wait-timeout", "120"}
	if action == "update" {
		args = append(args, "--pull", "never")
	}
	if preserveScale {
		counts := map[string]int{}
		for _, v := range old {
			counts[v.Config.Labels[serviceLabel]]++
		}
		for service, count := range counts {
			args = append(args, "--scale", service+"="+strconv.Itoa(count))
		}
	}
	args = append(args, selected...)
	m.message(taskID, 50, "正在应用当前项目配置并等待服务健康")
	_, deployErr := m.compose(ctx, p, args...)
	if deployErr == nil {
		baselines := map[string]int{}
		for _, v := range old {
			baselines[v.ID] = v.RestartCount
		}
		current, err := m.projectContainers(ctx, p, selected)
		deployErr = err
		if deployErr == nil {
			for _, v := range current {
				if v.State.Running {
					if err := utiles.WaitExistingContainer(ctx, m.Context, v.ID, baselines[v.ID]); err != nil {
						deployErr = err
						break
					}
				}
			}
		}
	}
	if deployErr == nil {
		m.Context.HubImageInfo.Clear()
		return nil
	}
	m.message(taskID, 75, "部署失败，正在恢复更新前的实际容器配置")
	recoveryCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	current, recoverErr := m.projectContainers(recoveryCtx, p, selected)
	oldIDs := map[string]bool{}
	for _, v := range old {
		oldIDs[v.ID] = true
	}
	if recoverErr == nil {
		for _, v := range current {
			if !oldIDs[v.ID] {
				if err := m.Context.DockerClient.ContainerRemove(recoveryCtx, v.ID, container.RemoveOptions{Force: true}); err != nil {
					recoverErr = err
					break
				}
			}
		}
	}
	if recoverErr == nil {
		for _, v := range old {
			if err := utiles.RestoreSnapshot(recoveryCtx, m.Context, v); err != nil {
				recoverErr = err
				break
			}
		}
	}
	progress, _ := m.Context.GetProgress(taskID)
	if recoverErr != nil {
		cleanup = false
		progress.Status = "rollback_failed"
		m.Context.UpdateProgress(taskID, progress)
		return fmt.Errorf("部署失败且恢复失败: %v；恢复错误: %v。恢复资料保存在 %s", deployErr, recoverErr, snapshotPath)
	}
	progress.Status = "rolled_back"
	m.Context.UpdateProgress(taskID, progress)
	return fmt.Errorf("部署失败，已恢复更新前容器；项目文件保留当前编辑内容，卷内数据不回退: %v", deployErr)
}
