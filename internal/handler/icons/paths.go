package icons

import (
	"path/filepath"

	"github.com/onlyLTY/dockerCopilot/internal/node"
)

var (
	imageUploadDir = filepath.Join(node.DataDir(), "config", "image")
	imageLogosPath = filepath.Join(node.DataDir(), "config", "imageLogos.js")
)
