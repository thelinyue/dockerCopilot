package management

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestComposeDraftSyntaxErrorsAreChinese(t *testing.T) {
	for _, test := range []struct {
		name, file, content, message string
		valid, line                  bool
	}{
		{"YAML", "compose.yaml", "# 注释\r\nservices:\r\n  app:\r\n    image: local:1\r\n", "", true, false},
		{"JSON", "override.json", `{"services":{"app":{"image":"local:1"}}}`, "", true, false},
		{"YAML缩进", "compose.yaml", "services:\n\tapp: {}\n", "空格缩进", false, true},
		{"JSON逗号", "override.json", "{\n\"services\":,\n}", "JSON 格式错误", false, true},
		{"不完整内容", "compose.yaml", "services:\n  app: [unfinished", "配置内容不完整", false, true},
		{"顶层类型", "compose.yaml", "- app\n", "顶层必须为对象", false, true},
		{"多个文档", "compose.yaml", "services: {}\n---\nservices: {}\n", "只能包含一个", false, false},
		{"文件过大", "compose.yaml", strings.Repeat("x", maxComposeSize+1), "2 MiB", false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := syntaxValidation(test.file, test.content)
			if got.Valid != test.valid || !strings.Contains(got.Message, test.message) || (test.line && got.Line <= 0) {
				t.Fatal("草稿检查结果不正确", got)
			}
			if err := validateSyntax(test.file, test.content); (err == nil) != test.valid {
				t.Fatal("保存与草稿的语法检查不一致", err)
			}
		})
	}
}

func TestComposeConfigErrorsAreChineseAndDoNotExposeValues(t *testing.T) {
	for _, test := range []struct{ detail, want string }{
		{"validating -: services.app.image must be a string", "services.app.image 必须为字符串"},
		{"validating -: services.app additional properties 'wrong_key' not allowed", "不支持的字段 wrong_key"},
		{`service "app" depends on undefined service "missing": invalid compose project`, "依赖的服务“missing”未定义"},
		{`service "app" refers to undefined volume absent: invalid compose project`, "引用的卷“absent”未定义"},
		{`service "app" has neither an image nor a build context specified`, "设置 image 或 build"},
		{"invalid containerPort: private-value", "端口格式错误"},
		{"env file /private-value not found", "无法读取环境文件"},
		{"required variable PRIVATE_KEY is missing a value: private-value", "环境变量解析失败"},
		{"yaml: line 3: private-value", "YAML 格式错误"},
		{"unexpected plugin output: private-value", "项目配置无效"},
	} {
		got := composeConfigMessage(test.detail)
		if !strings.Contains(got, test.want) || strings.Contains(got, "private-value") {
			t.Fatal("中文错误转换或敏感值过滤失败", got)
		}
	}
}

func TestComposeDraftUsesStdinAndKeepsFilesUnchanged(t *testing.T) {
	m, root := fileManager(t)
	main := filepath.Join(root, "compose.yaml")
	override := filepath.Join(root, "compose.override.json")
	original := "# keep\r\nservices:\r\n  app:\r\n    image: local:1\r\n"
	if err := os.WriteFile(main, []byte(original), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(override, []byte(`{"services":{}}`), 0644); err != nil {
		t.Fatal(err)
	}
	p, err := m.ImportProject("draft-test", []string{main, override})
	if err != nil {
		t.Fatal(err)
	}
	draft := `{"services":{"app":{"image":"local:2"}}}`
	cmd, err := composeCommand(context.Background(), p, 1, draft, "config", "--quiet")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"docker", "compose", "--ansi", "never", "-p", p.Name, "--project-directory", root, "-f", main, "-f", "-", "config", "--quiet"}
	stdin, _ := io.ReadAll(cmd.Stdin)
	if !reflect.DeepEqual(cmd.Args, want) || cmd.Dir != root || string(stdin) != draft {
		t.Fatal("检查草稿改变了文件顺序、项目目录或输入", cmd.Args, cmd.Dir)
	}
	result, err := m.ValidateFile(context.Background(), p.ID, 0, "services:\n\tbad: {}")
	if err != nil || result.Valid || result.SyntaxValid || result.Line <= 0 {
		t.Fatal("语法错误应在运行 Compose 前返回", result, err)
	}
	for _, index := range []int{-1, 2} {
		if _, err := m.ValidateFile(context.Background(), p.ID, index, draft); err == nil {
			t.Fatal("接受了越界文件索引", index)
		}
	}
	got, _ := os.ReadFile(main)
	if string(got) != original || len(m.Context.Tasks()) != 0 {
		t.Fatal("草稿检查写入了文件或创建了任务")
	}
	outside := filepath.Join(t.TempDir(), "outside.yaml")
	os.WriteFile(outside, []byte("services: {}"), 0600)
	p.Files[0] = outside
	if _, err := composeCommand(context.Background(), p, 0, draft, "config", "--quiet"); err == nil {
		t.Fatal("stdin 替换不应绕过配置文件的目录边界")
	}
}

// 此项仅运行官方 config，不连接业务 Docker 引擎、不拉取镜像、不保存草稿。
func TestComposeDraftOfficialConfig(t *testing.T) {
	if os.Getenv("DOCKERCOPILOT_COMPOSE_TEST") != "1" {
		t.Skip("设置 DOCKERCOPILOT_COMPOSE_TEST=1 后使用本机官方 Compose 验证草稿")
	}
	if err := exec.Command("docker", "compose", "version").Run(); err != nil {
		t.Fatal("官方 Compose 不可用", err)
	}
	m, root := fileManager(t)
	main := filepath.Join(root, "compose.yaml")
	override := filepath.Join(root, "compose.override.json")
	original := "# original\nservices:\n  app:\n    image: ${IMAGE}\n    env_file: ./service.env\n    volumes: [./data:/data]\n"
	files := map[string]string{
		main: original, override: `{"services":{"app":{"ports":["8080:80"]}}}`,
		filepath.Join(root, ".env"): "IMAGE=local-fixture:1\n", filepath.Join(root, "service.env"): "KEEP=private-value\n",
	}
	for path, text := range files {
		if err := os.WriteFile(path, []byte(text), 0644); err != nil {
			t.Fatal(err)
		}
	}
	os.Mkdir(filepath.Join(root, "data"), 0755)
	p, err := m.ImportProject("draft-test", []string{main, override})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		index   int
		content string
		valid   bool
		message string
	}{
		{0, original, true, ""},
		{1, `{"services":{"app":{"ports":["8081:80"]}}}`, true, ""},
		{0, strings.Replace(original, "image: ${IMAGE}", "image: [local:2]", 1), false, "字符串"},
		{1, `{"services":{"app":{"wrong_key":true}}}`, false, "不支持的字段"},
		{0, strings.Replace(original, "./service.env", "./missing.env", 1), false, "环境文件"},
	} {
		result, err := m.ValidateFile(context.Background(), p.ID, test.index, test.content)
		if err != nil || result.Valid != test.valid || !result.SyntaxValid || !strings.Contains(result.Message, test.message) {
			t.Fatal("官方草稿检查未按项目原规则解析", result, err)
		}
	}
	for path, original := range files {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != original {
			t.Fatal("官方检查改写了项目文件", path, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := m.ValidateFile(ctx, p.ID, 0, original); err == nil {
		t.Fatal("取消的检查不能报告通过")
	}
}
