//go:build linux

package management

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// 持有逐段 O_NOFOLLOW 打开的目录 fd，避免检查路径后目录被替换成符号链接。
func composeParent(root, path string) (*os.File, string, error) {
	if _, _, err := resolveFile(root, path); err != nil {
		return nil, "", err
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return nil, "", err
	}
	fd, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, "", err
	}
	parts := strings.Split(rel, string(filepath.Separator))
	for _, part := range parts[:len(parts)-1] {
		next, err := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if err != nil {
			return nil, "", fmt.Errorf("项目目录发生变化或包含符号链接，请重新加载")
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), filepath.Dir(path)), parts[len(parts)-1], nil
}
func readComposeAt(parent *os.File, name string) ([]byte, os.FileInfo, error) {
	fd, err := unix.Openat(int(parent.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("无法读取配置，文件可能已变化或成为符号链接")
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxComposeSize {
		return nil, nil, fmt.Errorf("只支持不超过 2 MiB 的普通配置文件")
	}
	b, err := io.ReadAll(io.LimitReader(f, maxComposeSize+1))
	if len(b) > maxComposeSize {
		return nil, nil, fmt.Errorf("配置文件超过 2 MiB")
	}
	return b, info, err
}
func readComposeFile(root, path string) ([]byte, error) {
	parent, name, err := composeParent(root, path)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	b, _, err := readComposeAt(parent, name)
	return b, err
}
func writeComposeFile(root, path, original, content string) error {
	parent, name, err := composeParent(root, path)
	if err != nil {
		return err
	}
	defer parent.Close()
	current, info, err := readComposeAt(parent, name)
	if err != nil {
		return err
	}
	if string(current) != original {
		return fmt.Errorf("文件已被其他页面或宿主机修改，请重新加载后合并；本次未覆盖")
	}
	if info.Mode().Perm()&0222 == 0 {
		return fmt.Errorf("配置文件为只读，请检查文件权限和目录挂载")
	}
	f, err := os.CreateTemp(fmt.Sprintf("/proc/self/fd/%d", parent.Fd()), ".dockercopilot-edit-*")
	if err != nil {
		return fmt.Errorf("无法保存，请检查目录是否以读写方式挂载: %w", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if owner, ok := info.Sys().(*syscall.Stat_t); ok {
		ownInfo, statErr := f.Stat()
		if statErr != nil {
			return statErr
		}
		own, _ := ownInfo.Sys().(*syscall.Stat_t)
		if own != nil && (owner.Uid != own.Uid || owner.Gid != own.Gid) {
			if err := f.Chown(int(owner.Uid), int(owner.Gid)); err != nil {
				return fmt.Errorf("无法保留配置文件所属用户和组: %w", err)
			}
		}
	}
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
	current, _, err = readComposeAt(parent, name)
	if err != nil {
		return err
	}
	if string(current) != original {
		return fmt.Errorf("保存期间文件发生变化，请重新加载后合并")
	}
	if err = unix.Renameat(int(parent.Fd()), filepath.Base(f.Name()), int(parent.Fd()), name); err != nil {
		return err
	}
	if err := parent.Sync(); err != nil {
		return fmt.Errorf("文件已保存，但目录同步失败，请重新加载核对后再部署: %w", err)
	}
	return nil
}
