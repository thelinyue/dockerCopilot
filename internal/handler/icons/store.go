package icons

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"text/scanner"

	"github.com/distribution/reference"
	"github.com/google/uuid"
)

const iconPathPrefix = "/src/config/image/"

// 同一节点的读、改、写及引用检查共用锁，避免同时上传或删除时丢失其他仓库的映射。
var iconConfigMu sync.RWMutex

func normalizeRepository(value string) (string, error) {
	named, err := reference.ParseNormalizedNamed(strings.TrimSpace(value))
	if err != nil {
		return "", fmt.Errorf("镜像名称无效，请填写镜像仓库名称，可包含仓库地址、端口和标签")
	}
	return reference.FamiliarName(reference.TrimNamed(named)), nil
}

func loadIcons() (map[string]string, error) {
	iconConfigMu.RLock()
	defer iconConfigMu.RUnlock()
	return readIconConfig()
}

func readIconConfig() (map[string]string, error) {
	info, err := os.Lstat(imageLogosPath)
	if os.IsNotExist(err) {
		return map[string]string{}, nil
	}
	if err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("无法读取图标配置，请检查数据目录权限及 imageLogos.js 文件类型")
	}
	content, err := os.ReadFile(imageLogosPath)
	if err != nil {
		return nil, fmt.Errorf("读取图标配置失败，请检查数据目录权限: %w", err)
	}
	// 只接受项目已有的字符串映射语法，不执行 JavaScript，也不从损坏文件中猜测并覆盖配置。
	var tokens scanner.Scanner
	tokens.Init(strings.NewReader(string(content)))
	tokens.Mode = scanner.ScanIdents | scanner.ScanStrings | scanner.ScanComments | scanner.SkipComments
	invalid := false
	tokens.Error = func(*scanner.Scanner, string) { invalid = true }
	fail := func() (map[string]string, error) {
		return nil, fmt.Errorf("图标配置格式无效，请检查 imageLogos.js，原文件未修改")
	}
	for _, expected := range []string{"export", "const", "customImageLogos", "=", "{"} {
		tokens.Scan()
		if tokens.TokenText() != expected {
			return fail()
		}
	}
	values := map[string]string{}
	token := tokens.Scan()
	for token != '}' {
		if token != scanner.String {
			return fail()
		}
		var key, value string
		if json.Unmarshal([]byte(tokens.TokenText()), &key) != nil {
			return fail()
		}
		if tokens.Scan() != ':' || tokens.Scan() != scanner.String {
			return fail()
		}
		if json.Unmarshal([]byte(tokens.TokenText()), &value) != nil {
			return fail()
		}
		if _, exists := values[key]; exists || key == "" || value == "" {
			return fail()
		}
		values[key] = value
		token = tokens.Scan()
		if token == ',' {
			token = tokens.Scan()
		} else if token != '}' {
			return fail()
		}
	}
	if tokens.Scan() == ';' {
		tokens.Scan()
	}
	if invalid || tokens.TokenText() != "" {
		return fail()
	}
	return values, nil
}

func saveIconConfig(values map[string]string) error {
	content, err := json.MarshalIndent(values, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(imageLogosPath), 0755); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(imageLogosPath), ".image-logos-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0644); err == nil {
		_, err = io.WriteString(file, "// 自定义镜像图标：按仓库应用到全部标签。\nexport const customImageLogos = "+string(content)+";\n")
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), imageLogosPath)
}

func changeIcon(repository, filename string) (string, error) {
	iconConfigMu.Lock()
	defer iconConfigMu.Unlock()
	values, err := readIconConfig()
	if err != nil {
		return "", err
	}
	previous := map[string]bool{}
	for key, value := range values {
		if normalized, normalizeErr := normalizeRepository(key); normalizeErr == nil && normalized == repository {
			previous[value] = true
			delete(values, key)
		}
	}
	if filename != "" {
		values[repository] = iconPathPrefix + filename
	}
	if err = saveIconConfig(values); err != nil {
		return "", fmt.Errorf("保存图标配置失败，原配置已保留，请检查数据目录空间及权限: %w", err)
	}
	for _, value := range values {
		delete(previous, value)
	}
	warning := ""
	for value := range previous {
		if err := removeUnusedIcon(value); err != nil {
			warning = "图标配置已保存，但旧图片回收失败，请检查图片目录权限"
		}
	}
	return warning, nil
}

func ensureImageDirectory() error {
	if err := os.MkdirAll(imageUploadDir, 0755); err != nil {
		return err
	}
	info, err := os.Lstat(imageUploadDir)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("图片目录必须为真实目录")
	}
	return nil
}

func iconFilePath(name string) (string, error) {
	if name == "" || name != filepath.Base(name) || strings.ContainsAny(name, `/\\`) {
		return "", fmt.Errorf("图标文件名无效")
	}
	root, err := filepath.Abs(imageUploadDir)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("图片目录不可用")
	}
	path := filepath.Join(root, name)
	info, err = os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("图标必须为普通文件")
	}
	return path, nil
}

func removeUnusedIcon(value string) error {
	if !strings.HasPrefix(value, iconPathPrefix) {
		return nil
	}
	name := strings.TrimPrefix(value, iconPathPrefix)
	ext := filepath.Ext(name)
	if _, allowed := allowedImageTypes[ext]; !allowed {
		return nil
	}
	id := strings.TrimSuffix(name, ext)
	parsed, err := uuid.Parse(id)
	// 仅回收程序生成的直接子文件；手工图片、历史孤立文件和链接均不删除。
	if err != nil || parsed.String() != id {
		return nil
	}
	path, err := iconFilePath(name)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return os.Remove(path)
}
