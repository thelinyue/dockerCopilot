param(
    [ValidateSet('setup', 'build', 'start', 'stop', 'status', 'logs', 'frontend', 'test')]
    [string]$Action = 'start'
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "命令执行失败（退出码 $LASTEXITCODE）：$Command $($Arguments -join ' ')"
    }
}

function Invoke-DevCompose {
    param([string[]]$ComposeArguments)
    # 不经过 shell 拼接，保留 Windows 路径中的空格和中文。
    $linuxPathOutput = & wsl.exe -d Debian --exec wslpath -a -u $projectRoot
    if ($LASTEXITCODE -ne 0) { throw '无法转换 WSL 项目路径，请确认 Debian 已启动。' }
    $linuxPath = $linuxPathOutput.Trim()
    Invoke-Checked wsl.exe (@('-d', 'Debian', '--cd', $linuxPath, '--exec', 'docker', 'compose',
        '--env-file', '.local/compose.env', '-f', 'dev/compose.yaml') + $ComposeArguments)
}

function Initialize-Dev {
    New-Item -ItemType Directory -Force -Path '.local/bin', '.local/data', '.local/logs' | Out-Null
    Copy-Item -LiteralPath '\\wsl.localhost\Debian\etc\ssl\certs\ca-certificates.crt' -Destination '.local/ca-certificates.crt' -Force
    if (-not (Test-Path -LiteralPath '.local/compose.env')) {
        # 每个工作区生成独立密钥；不写入版本控制，也不输出到日志。
        $secret = 'Dev-' + [Guid]::NewGuid().ToString('N')
        Set-Content -LiteralPath '.local/compose.env' -Value "secretKey=$secret" -Encoding ascii
    }
    if (-not (Test-Path -LiteralPath 'frontend/package-lock.json')) {
        throw '当前仓库缺少 frontend/package-lock.json，请确认已完整检出前后端源码。'
    }
    Push-Location frontend
    try { Invoke-Checked npm @('ci', '--no-audit', '--no-fund') }
    finally { Pop-Location }
    Invoke-Checked go @('mod', 'download')
}

function Build-Dev {
    if (-not (Test-Path -LiteralPath 'frontend/node_modules')) {
        throw '缺少前端依赖，请先运行 .\dev.ps1 setup。'
    }
    Push-Location frontend
    # 输出到 Go embed 目录，源码和构建产物分开管理。
    try { Invoke-Checked npm @('run', 'build', '--', '--outDir', '../front') }
    finally { Pop-Location }
    # 保留目录，不递归删除用户文件；Go embed 已由前端构建提供完整页面。
    New-Item -ItemType Directory -Force -Path 'front', '.local/bin' | Out-Null
    # 复用 WSL 已安装的官方工具，开发镜像构建无需重新拉取 CLI 软件包。
    Copy-Item -LiteralPath '\\wsl.localhost\Debian\usr\bin\docker' -Destination '.local/bin/docker' -Force
    $pluginPath = (& wsl.exe -d Debian --exec docker info --format '{{range .ClientInfo.Plugins}}{{if eq .Name "compose"}}{{.Path}}{{end}}{{end}}').Trim()
    if ($LASTEXITCODE -ne 0 -or -not $pluginPath) { throw 'WSL 缺少官方 Compose 插件，请先安装 docker-compose-plugin。' }
    Copy-Item -LiteralPath ('\\wsl.localhost\Debian' + $pluginPath.Replace('/', '\')) -Destination '.local/bin/docker-compose' -Force
    $wslMachine = (& wsl.exe -d Debian --exec uname -m).Trim()
    if ($LASTEXITCODE -ne 0) { throw '无法确认 WSL 架构。' }
    $devArchitecture = switch ($wslMachine) {
        'x86_64' { 'amd64' }
        'aarch64' { 'arm64' }
        default { throw "开发镜像暂不支持 WSL 架构：$wslMachine" }
    }
    $previousGoos = $env:GOOS
    $previousGoarch = $env:GOARCH
    $previousCgo = $env:CGO_ENABLED
    try {
        $env:GOOS = 'linux'
        $env:GOARCH = $devArchitecture
        $env:CGO_ENABLED = '0'
        $version = (Get-Content -LiteralPath version -Raw).Trim() + '-dev'
        Invoke-Checked go @('build', '-trimpath', '-ldflags',
            "-X github.com/onlyLTY/dockerCopilot/internal/config.Version=$version",
            '-o', '.local/bin/dockerCopilot', '.')
    }
    finally {
        $env:GOOS = $previousGoos
        $env:GOARCH = $previousGoarch
        $env:CGO_ENABLED = $previousCgo
    }
}

Push-Location $projectRoot
try {
    switch ($Action) {
        'setup' { Initialize-Dev }
        'build' { Build-Dev }
        'start' {
            if (-not (Test-Path -LiteralPath '.local/compose.env')) {
                throw '缺少本地配置，请先运行 .\dev.ps1 setup。'
            }
            Build-Dev
            Invoke-DevCompose @('up', '-d', '--build')
            Write-Host '开发后端：http://127.0.0.1:12712/manager'
            Write-Host '登录密钥位于 .local/compose.env；前端热更新请运行 .\dev.ps1 frontend。'
        }
        'stop' { Invoke-DevCompose @('down') }
        'status' { Invoke-DevCompose @('ps') }
        'logs' { Invoke-DevCompose @('logs', '--tail', '100', '-f') }
        'frontend' {
            $previousApiUrl = $env:VITE_API_BASE_URL
            try {
                $env:VITE_API_BASE_URL = 'http://127.0.0.1:12712'
                Push-Location frontend
                try { Invoke-Checked npm @('run', 'dev', '--', '--host', '127.0.0.1', '--port', '12713', '--strictPort') }
                finally { Pop-Location }
            }
            finally { $env:VITE_API_BASE_URL = $previousApiUrl }
        }
        'test' { Invoke-Checked go @('test', './...') }
    }
}
finally { Pop-Location }
