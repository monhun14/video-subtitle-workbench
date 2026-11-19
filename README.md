# 切片字幕机

## 1. 功能介绍

切片字幕机是一款 Windows 桌面工具，用于视频裁剪、字幕识别和翻译。

- 导入并预览本地视频，按起止时间裁剪并导出 MP4。
- 分析 YouTube 视频链接，选择画质并下载，再导入为源视频。
- 使用阿里云百炼或火山引擎识别整段视频或裁剪片段，导出原文 SRT。
- 翻译识别结果或导入的 UTF-8 SRT，导出译文或双语 SRT。翻译支持阿里云百炼和火山方舟。

## 2. 本地部署与启动

### 准备环境

- Windows x64、Git、Node.js 18.20.0 或更高版本，以及 npm。
- 安装 Windows 版 FFmpeg。如果已加入 PATH，在 PowerShell 中运行 `ffmpeg -version` 和 `ffprobe -version` 检查。

如果没有把 FFmpeg 加入 PATH，在用于启动应用的 PowerShell 窗口中设置实际的 `bin` 路径。该目录应包含 `ffmpeg.exe` 和 `ffprobe.exe`。

```powershell
$env:FFMPEG_DIR = 'D:\……\ffmpeg\bin'
```

### 安装依赖并启动

在 PowerShell 中运行以下命令。已有源码时，直接进入项目根目录，从 `npm ci` 开始。

```powershell
git clone https://github.com/monhun14/video-subtitle-workbench.git
cd video-subtitle-workbench
npm ci
npm run dev
```

首次安装依赖需要联网。看到“切片字幕机”桌面窗口即表示启动成功。导入一个本地 MP4，确认能够播放并导出一段裁剪视频，即可验证本地媒体流程。如果终端提示端口占用，先释放 `5173` 端口，再运行 `npm run dev`。

### 配置可选功能

- **YouTube 下载**：首次使用前，在项目根目录运行 `npm run setup:downloader`，联网准备项目指定版本的 yt-dlp 和 Deno。准备完成后可在应用右上角打开“下载源视频”。
- **字幕识别与翻译**：联网后打开“服务设置”，分别配置要使用的识别和翻译服务凭证及所需模型。导入、播放和裁剪本地视频无需云服务凭证。

### 生成 Windows 安装包

准备好完整的 FFmpeg 发行包后，在项目根目录运行 `npm run package:win`。打包要求 FFmpeg 的 `bin` 上一级目录包含 `LICENSE.txt`。完成后运行 `release1.0/切片字幕机-1.0.0.exe`，安装完毕即可从开始菜单启动。安装版自带 FFmpeg、yt-dlp 和 Deno。
