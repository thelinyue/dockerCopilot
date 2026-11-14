package management

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type ComposeValidation struct {
	Valid       bool   `json:"valid"`
	SyntaxValid bool   `json:"syntaxValid"`
	Message     string `json:"message,omitempty"`
	Line        int    `json:"line,omitempty"`
}

var yamlLine = regexp.MustCompile(`\bline (\d+)`)

func syntaxValidation(path, content string) ComposeValidation {
	invalid := func(message string, line int) ComposeValidation {
		return ComposeValidation{Message: message, Line: line}
	}
	if len(content) > maxComposeSize {
		return invalid("配置文件不能超过 2 MiB，请精简后再保存。", 0)
	}
	if strings.EqualFold(filepath.Ext(path), ".json") && !json.Valid([]byte(content)) {
		var value any
		err := json.Unmarshal([]byte(content), &value)
		var syntax *json.SyntaxError
		line := 0
		if errors.As(err, &syntax) {
			line = strings.Count(content[:min(len(content), int(syntax.Offset))], "\n") + 1
		}
		return invalid("JSON 格式错误，请检查引号、逗号和括号是否完整。", line)
	}
	var value yaml.Node
	decoder := yaml.NewDecoder(strings.NewReader(content))
	if err := decoder.Decode(&value); err != nil {
		line := 0
		if match := yamlLine.FindStringSubmatch(err.Error()); len(match) > 1 {
			line, _ = strconv.Atoi(match[1])
		}
		return invalid(yamlErrorMessage(err.Error()), line)
	}
	var extra yaml.Node
	if err := decoder.Decode(&extra); err != io.EOF {
		return invalid("一个项目配置文件只能包含一个 YAML 文档，请将多个配置文件按顺序接管。", 0)
	}
	if len(value.Content) != 1 || value.Content[0].Kind != yaml.MappingNode {
		return invalid("项目配置顶层必须为对象，请使用 services 等字段组织配置。", 1)
	}
	return ComposeValidation{Valid: true, SyntaxValid: true}
}

func validateSyntax(path, content string) error {
	result := syntaxValidation(path, content)
	if result.Valid {
		return nil
	}
	if result.Line > 0 {
		return fmt.Errorf("第 %d 行：%s", result.Line, result.Message)
	}
	return errors.New(result.Message)
}

func yamlErrorMessage(detail string) string {
	switch {
	case strings.Contains(detail, "unknown escape"):
		return "字符串转义无效，请检查反斜杠或改用单引号。"
	case strings.Contains(detail, "unknown anchor"):
		return "引用了未定义的 YAML 锚点，请检查锚点与别名。"
	case strings.Contains(detail, "already defined"):
		return "配置键重复，请删除重复定义。"
	case strings.Contains(detail, "cannot start any token"), strings.Contains(detail, "tab character"):
		return "包含无效字符，请使用空格缩进并检查特殊字符。"
	case strings.Contains(detail, "expected ','"), strings.Contains(detail, "unexpected end"):
		return "配置内容不完整，请检查逗号、引号及括号是否闭合。"
	case strings.Contains(detail, "expected ':'"), strings.Contains(detail, "expected key"):
		return "键值格式错误，请检查冒号和缩进。"
	case strings.Contains(detail, "expected '-' indicator"):
		return "列表格式错误，请检查短横线与缩进。"
	default:
		return "YAML 格式错误，请检查缩进、冒号、引号和括号。"
	}
}

var composeFieldType = regexp.MustCompile(`([A-Za-z0-9_.\[\]-]+) must be (?:a |an )?(string|integer|number|boolean|object|mapping|array|list)`)
var composeExtraField = regexp.MustCompile(`(?i)additional propert(?:y|ies) ['"]?([A-Za-z0-9_.-]+)['"]? (?:is |are )?not allowed`)
var composeMissingService = regexp.MustCompile(`service "([A-Za-z0-9_.-]+)" depends on undefined service "([A-Za-z0-9_.-]+)"`)
var composeMissingResource = regexp.MustCompile(`service "([A-Za-z0-9_.-]+)" refers to undefined (volume|network|secret|config) ["']?([A-Za-z0-9_.-]+)`)

// 只提取字段名等结构信息，不把可能包含环境值或密钥的 CLI 原文返回页面或日志。
func composeConfigMessage(detail string) string {
	if match := composeFieldType.FindStringSubmatch(detail); len(match) > 2 {
		kind := map[string]string{"string": "字符串", "integer": "整数", "number": "数字", "boolean": "布尔值", "object": "对象", "mapping": "对象", "array": "列表", "list": "列表"}[match[2]]
		return fmt.Sprintf("字段 %s 必须为%s，请检查该字段的格式。", match[1], kind)
	}
	if match := composeExtraField.FindStringSubmatch(detail); len(match) > 1 {
		return fmt.Sprintf("存在不支持的字段 %s，请检查字段名及其所在层级。", match[1])
	}
	if match := composeMissingService.FindStringSubmatch(detail); len(match) > 2 {
		return fmt.Sprintf("服务“%s”依赖的服务“%s”未定义，请检查 depends_on。", match[1], match[2])
	}
	if match := composeMissingResource.FindStringSubmatch(detail); len(match) > 3 {
		kind := map[string]string{"volume": "卷", "network": "网络", "secret": "密钥", "config": "配置"}[match[2]]
		return fmt.Sprintf("服务“%s”引用的%s“%s”未定义，请在顶层补充定义。", match[1], kind, match[3])
	}
	switch {
	case strings.Contains(detail, "neither an image nor a build"):
		return "服务缺少镜像或构建配置，请设置 image 或 build。"
	case strings.Contains(detail, "env file"):
		return "无法读取环境文件，请检查 env_file 路径、文件权限及目录挂载。"
	case strings.Contains(detail, "required variable"), strings.Contains(detail, "interpolat"):
		return "环境变量解析失败，请检查 .env、必需变量和变量默认值。"
	case strings.Contains(detail, "containerPort"), strings.Contains(detail, "hostPort"), strings.Contains(detail, "invalid port"):
		return "端口格式错误，请检查 ports 的端口号与映射格式。"
	case strings.Contains(detail, "cycle"), strings.Contains(detail, "cyclic"):
		return "服务依赖存在循环，请检查 depends_on。"
	case strings.Contains(detail, "yaml:"), strings.Contains(detail, "YAML"):
		return "项目中的配置文件存在 YAML 格式错误，请检查主文件和 override 文件。"
	case strings.Contains(detail, "no such file"), strings.Contains(detail, "permission denied"):
		return "无法读取项目引用的文件，请检查文件路径、权限及目录挂载。"
	default:
		return "项目配置无效，请检查字段格式、服务依赖、环境文件和挂载路径。"
	}
}

func (m *Manager) ValidateFile(ctx context.Context, id string, index int, content string) (ComposeValidation, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	p, err := m.Project(ctx, id)
	if err != nil {
		return ComposeValidation{}, err
	}
	if index < 0 || index >= len(p.Files) {
		return ComposeValidation{}, fmt.Errorf("文件索引无效，请重新选择配置文件")
	}
	result := syntaxValidation(p.Files[index], content)
	if !result.Valid {
		return result, nil
	}
	cmd, err := composeCommand(ctx, p, index, content, "config", "--quiet")
	if err != nil {
		return ComposeValidation{}, err
	}
	var stderr limitedOutput
	cmd.Stderr = &stderr
	cmd.Stdout = io.Discard
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ComposeValidation{}, fmt.Errorf("配置检查超时或已取消，请稍后重试")
		}
		if errors.Is(err, exec.ErrNotFound) {
			return ComposeValidation{}, fmt.Errorf("无法检查配置：当前容器缺少 Docker CLI，请升级 DockerCopilot 镜像")
		}
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return ComposeValidation{}, fmt.Errorf("无法运行配置检查，请检查 Docker CLI 与项目管理组件")
		}
		if strings.Contains(stderr.String(), "not a docker command") || strings.Contains(stderr.String(), "unknown command") {
			return ComposeValidation{}, fmt.Errorf("当前设备缺少可用的项目管理组件，请升级 DockerCopilot 镜像")
		}
		return ComposeValidation{SyntaxValid: true, Message: composeConfigMessage(stderr.String())}, nil
	}
	return ComposeValidation{Valid: true, SyntaxValid: true}, nil
}
