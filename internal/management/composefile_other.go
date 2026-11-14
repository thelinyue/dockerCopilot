//go:build !linux

package management

import (
	"fmt"
	"os"
	"path/filepath"
)

func readComposeFile(root, path string) ([]byte, error) {
	path, _, err := resolveFile(root, path)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(path)
}
func writeComposeFile(root, path, original, content string) error {
	path, info, err := resolveFile(root, path)
	if err != nil {
		return err
	}
	if info.Mode().Perm()&0222 == 0 {
		return fmt.Errorf("配置文件为只读，请检查文件权限和目录挂载")
	}
	current, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if string(current) != original {
		return fmt.Errorf("文件已被其他页面或宿主机修改，请重新加载后合并；本次未覆盖")
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".dockercopilot-edit-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err = f.Chmod(info.Mode().Perm()); err == nil {
		_, err = f.WriteString(content)
	}
	if err == nil {
		err = f.Sync()
	}
	if err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	current, err = readComposeFile(root, path)
	if err != nil {
		return err
	}
	if string(current) != original {
		return fmt.Errorf("保存期间文件发生变化，请重新加载后合并")
	}
	return os.Rename(f.Name(), path)
}
