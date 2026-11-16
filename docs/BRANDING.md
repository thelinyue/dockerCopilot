# 应用图标

DockerCopilot 使用蓝青色的几何容器标志。三组圆角模块围合中央留白，形成紧凑的立方体轮廓，表达容器、项目与设备的统一管理。应用名称保持 Docker Copilot。

PWA 的 `name`、`short_name` 与 iOS 主屏幕名称统一为 `Docker Copilot`，避免安装时显示为 `Docker`。已有安装的名称与图标更新时机取决于浏览器及系统，不能以网页显示正常代替真机安装验收。

原稿使用内置 imagegen 生成，目标为 1024 × 1024，工具实际输出为 1254 × 1254。仓库保留选定的第一版 A 原图，所有应用资源仅作等比缩放；maskable 版本增加安全留白。

## 资源与用途

| 资源 | 实际尺寸 | 用途 |
| --- | --- | --- |
| `assets/dockercopilot-icon.png` | 1254 × 1254 | 选定原稿，后续导出的来源 |
| `frontend/src/assets/DockerCopilot-logo.png` | 512 × 512 | 登录页、导航、关于页面 |
| `frontend/public/logo.png` | 512 × 512 | PWA 普通图标及原有公开地址 |
| `frontend/public/logo-192.png` | 192 × 192 | PWA 普通图标 |
| `frontend/public/logo-maskable.png` | 512 × 512 | PWA 可裁切图标，四边各增加约 10% 留白 |
| `frontend/public/apple-touch-icon.png` | 180 × 180 | iOS 添加到主屏幕 |
| `frontend/public/favicon.png` | 32 × 32 | 浏览器标签 |

资源保持原稿的比例、配色与背景，不再额外绘制外层圆角，由页面或操作系统进行裁切。更新时应同步导出上述尺寸、核对 manifest 声明，并递增已有 Service Worker 缓存版本，避免旧缓存继续显示旧图标。新增根路径图标还需加入 Go 静态资源路由与 PWA 预缓存列表。

内置镜像库中用于识别上游 `0nlylty/dockercopilot` 的图标继续表示上游镜像，与本项目的应用图标分别维护。

## 原始生成提示词

使用内置 imagegen，`transparent_background: false`，无参考图片。

```text
Use case: logo-brand. Asset type: original application icon candidate A, 'Module Convergence', for DockerCopilot, a self-hosted container, Compose project, and multi-device management tool. Create ONE finished square 1024 x 1024 application icon, not a presentation sheet. Background: uniform very pale ice blue #F0F9FF, full-bleed square, no outer frame. Subject: a distinctive compact geometric hub assembled from exactly three bold, flat, rounded modular forms converging around one clearly legible central negative space. The modules should suggest grouped software containers and coordinated management, with a balanced near-hexagonal overall silhouette. Purposeful original geometry, simple optical balance, strong filled shapes, generous gaps, no thin outlines, no small details. Palette: deep azure #0284C7 and bright cyan #22D3EE; ensure the primary silhouette reads as one coherent emblem. Medium: rigorously flat vector-like logo, solid fills, clean precise edges, professional and approachable. Composition: centered, emblem occupies about 66–70 percent of the square with generous safe margins, readable at 16–24 pixels. Constraints: no typography, no letters, no words, no numbers, no whale, no Docker logo, no circle border, no existing product logos, no watermark, no mockup, no labels, no shadows, no gradients, no texture, no 3D, no extra decoration. Deliver only the icon artwork.
```
