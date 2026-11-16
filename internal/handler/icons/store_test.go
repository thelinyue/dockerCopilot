package icons

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func setupIconStore(t *testing.T) {
	t.Helper()
	previousDir, previousConfig := imageUploadDir, imageLogosPath
	root := t.TempDir()
	imageUploadDir, imageLogosPath = filepath.Join(root, "image"), filepath.Join(root, "imageLogos.js")
	t.Cleanup(func() { imageUploadDir, imageLogosPath = previousDir, previousConfig })
}

func TestNormalizeRepository(t *testing.T) {
	for input, expected := range map[string]string{
		"redis:7": "redis", "docker.io/library/redis:8": "redis",
		"registry.local:5000/team/app:2":                                   "registry.local:5000/team/app",
		"registry.local:5000/team/app:2@sha256:" + strings.Repeat("a", 64): "registry.local:5000/team/app",
	} {
		actual, err := normalizeRepository(input)
		if err != nil || actual != expected {
			t.Fatalf("%s: got %q, %v", input, actual, err)
		}
	}
	if _, err := normalizeRepository("../invalid image"); err == nil {
		t.Fatal("invalid name accepted")
	}
}

func TestStoreEmptyAndDamagedConfig(t *testing.T) {
	setupIconStore(t)
	values, err := loadIcons()
	if err != nil || len(values) != 0 {
		t.Fatalf("missing config: %v, %v", values, err)
	}
	original := []byte("export const customImageLogos = { broken\n")
	os.WriteFile(imageLogosPath, original, 0600)
	if _, err = changeIcon("redis", "new.png"); err == nil {
		t.Fatal("damaged config overwritten")
	}
	after, _ := os.ReadFile(imageLogosPath)
	if string(after) != string(original) {
		t.Fatal("damaged config changed")
	}
}

func TestConcurrentChangesKeepOtherRepositories(t *testing.T) {
	setupIconStore(t)
	if _, err := changeIcon("to-delete", "old.png"); err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	for _, repository := range []string{"team/a", "team/b", "team/c", "team/d"} {
		group.Add(1)
		go func(repository string) {
			defer group.Done()
			if _, err := changeIcon(repository, "new.png"); err != nil {
				t.Error(err)
			}
		}(repository)
	}
	group.Add(1)
	go func() {
		defer group.Done()
		if _, err := changeIcon("to-delete", ""); err != nil {
			t.Error(err)
		}
	}()
	group.Add(1)
	go func() {
		defer group.Done()
		for i := 0; i < 10; i++ {
			if _, err := loadIcons(); err != nil {
				t.Error(err)
			}
		}
	}()
	group.Wait()
	values, err := loadIcons()
	if err != nil || len(values) != 4 {
		t.Fatalf("lost mappings: %v, %v", values, err)
	}
}

func TestReplaceMergesLegacyKeysAndProtectsReferencedAndUnrelatedFiles(t *testing.T) {
	setupIconStore(t)
	if err := ensureImageDirectory(); err != nil {
		t.Fatal(err)
	}
	obsolete := "11111111-1111-4111-8111-111111111111.png"
	shared := "22222222-2222-4222-8222-222222222222.png"
	orphan := "33333333-3333-4333-8333-333333333333.png"
	manual := "manual.png"
	for _, name := range []string{obsolete, shared, orphan, manual} {
		if err := os.WriteFile(filepath.Join(imageUploadDir, name), []byte("fixture"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	values := map[string]string{
		"redis":                     iconPathPrefix + obsolete,
		"redis:7":                   iconPathPrefix + shared,
		"docker.io/library/redis:8": iconPathPrefix + manual,
		"team/other":                iconPathPrefix + shared,
	}
	if err := saveIconConfig(values); err != nil {
		t.Fatal(err)
	}
	if warning, err := changeIcon("redis", "new.png"); err != nil || warning != "" {
		t.Fatalf("replace: %s %v", warning, err)
	}
	after, err := loadIcons()
	if err != nil || len(after) != 2 || after["redis"] != iconPathPrefix+"new.png" || after["team/other"] != iconPathPrefix+shared {
		t.Fatalf("merge: %v %v", after, err)
	}
	if _, err := os.Stat(filepath.Join(imageUploadDir, obsolete)); !os.IsNotExist(err) {
		t.Fatal("obsolete generated file retained")
	}
	for _, name := range []string{shared, orphan, manual} {
		if _, err := os.Stat(filepath.Join(imageUploadDir, name)); err != nil {
			t.Fatalf("protected file %s: %v", name, err)
		}
	}
	if _, err := changeIcon("team/other", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(imageUploadDir, shared)); !os.IsNotExist(err) {
		t.Fatal("last reference did not recycle image")
	}
}

func TestCleanupRefusesTraversalUnsupportedFilesAndLinks(t *testing.T) {
	setupIconStore(t)
	if err := ensureImageDirectory(); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(filepath.Dir(imageUploadDir), "11111111-1111-4111-8111-111111111111.png")
	if err := os.WriteFile(outside, []byte("keep"), 0644); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{iconPathPrefix + "../" + filepath.Base(outside), outside, iconPathPrefix + "11111111-1111-4111-8111-111111111111.svg"} {
		_ = removeUnusedIcon(path)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatal("outside file removed")
	}
	t.Run("symlink warning preserves committed config", func(t *testing.T) {
		name := "22222222-2222-4222-8222-222222222222.png"
		link := filepath.Join(imageUploadDir, name)
		if err := os.Symlink(outside, link); err != nil {
			t.Skipf("符号链接不可用: %v", err)
		}
		if err := saveIconConfig(map[string]string{"redis:7": iconPathPrefix + name}); err != nil {
			t.Fatal(err)
		}
		warning, err := changeIcon("redis", "new.png")
		if err != nil || warning == "" {
			t.Fatalf("cleanup result: %s %v", warning, err)
		}
		values, err := loadIcons()
		if err != nil || values["redis"] != iconPathPrefix+"new.png" {
			t.Fatal("cleanup failure reverted successful config")
		}
		if _, err := os.Lstat(link); err != nil {
			t.Fatal("link removed")
		}
		if _, err := os.Stat(outside); err != nil {
			t.Fatal("link target removed")
		}
	})
}

func TestAtomicSaveFailurePreservesDestinationAndRemovesTemporaryFile(t *testing.T) {
	setupIconStore(t)
	// 非空目录不能被文件替换，稳定覆盖原子 rename 的失败分支，不依赖运行用户的权限。
	if err := os.Mkdir(imageLogosPath, 0755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(imageLogosPath, "keep")
	if err := os.WriteFile(marker, []byte("original"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := saveIconConfig(map[string]string{"redis": "new.png"}); err == nil {
		t.Fatal("replace directory unexpectedly succeeded")
	}
	content, err := os.ReadFile(marker)
	if err != nil || string(content) != "original" {
		t.Fatal("failed replacement damaged destination")
	}
	temporary, _ := filepath.Glob(filepath.Join(filepath.Dir(imageLogosPath), ".image-logos-*"))
	if len(temporary) != 0 {
		t.Fatal("temporary config leaked")
	}
}

func TestUploadSaveFailureKeepsOldMappingAndRemovesNewImage(t *testing.T) {
	setupIconStore(t)
	if err := ensureImageDirectory(); err != nil {
		t.Fatal(err)
	}
	if err := saveIconConfig(map[string]string{"redis": iconPathPrefix + "old.png"}); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		if err := os.Chmod(imageLogosPath, 0444); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(imageLogosPath, 0644) })
	} else {
		root := filepath.Dir(imageLogosPath)
		if err := os.Chmod(root, 0555); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(root, 0755) })
		probe, err := os.CreateTemp(root, ".permission-probe-*")
		if err == nil {
			probe.Close()
			os.Remove(probe.Name())
			t.Skip("运行用户可绕过目录权限，无法在此用户下模拟保存失败")
		}
	}
	verifyFailedUpload(t)
}
