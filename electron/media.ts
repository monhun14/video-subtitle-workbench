import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve, extname } from 'node:path'
import { access, unlink, link, copyFile, mkdtemp, rm, realpath, lstat, writeFile, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { MediaInfo, DownloadJob, DownloadQuality } from '../src/env'
import { app } from 'electron'

let youtubeNextRequestAt = 0
let youtubeRateLimitUntil = 0
let youtubeCookies = ''
let youtubeCookiesRevision = 0

export function setYoutubeCookies(text = '', allowEmpty = false) {
  if (!text) { youtubeCookies = ''; youtubeCookiesRevision++; return }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (!/^# (?:Netscape )?HTTP Cookie File\s*$/.test(lines[0])) throw new Error('请使用 Netscape 格式的 YouTube Cookies 文件。')
  const cookies: string[] = []
  for (const line of lines.slice(1)) {
    if (!line.trim() || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue
    const fields = line.replace(/^#HttpOnly_/, '').split('\t')
    const domain = fields[0]?.replace(/^\./, '').toLowerCase()
    if (domain !== 'youtube.com' && !domain?.endsWith('.youtube.com')) continue
    if (fields.length !== 7 || fields.some(field => /[\x00-\x1f\x7f]/.test(field)) || !['TRUE', 'FALSE'].includes(fields[1]) || !['TRUE', 'FALSE'].includes(fields[3]) || !/^\d+$/.test(fields[4]) || !fields[5]) throw new Error('YouTube Cookies 文件内容无效，请重新导出。')
    cookies.push(line)
  }
  if (!cookies.length && !allowEmpty) throw new Error('文件中没有 YouTube 域名的 Cookies，请重新选择。')
  youtubeCookies = `# Netscape HTTP Cookie File\n${cookies.join('\n')}\n`
  youtubeCookiesRevision++
}

function executable(name: 'ffmpeg' | 'ffprobe') {
  const directory = process.env.FFMPEG_DIR || (app?.isPackaged ? join(process.resourcesPath, 'ffmpeg') : undefined)
  return directory ? join(directory, `${name}.exe`) : name
}

function run(tool: string, args: string[], progress?: (text: string) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { windowsHide: true, shell: false, signal })
    let stdout = '', stderr = ''
    let processError: Error | undefined
    const timeout = setTimeout(() => { processError = new Error('媒体处理超时，请尝试较短的视频片段。'); child.kill() }, 30 * 60 * 1000)
    child.stdout.on('data', data => { if (progress) progress(String(data)); else stdout += data })
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-12000) })
    child.on('error', error => {
      clearTimeout(timeout)
      processError = new Error(error.name === 'AbortError' ? '任务已取消。' : (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? '未找到 FFmpeg / ffprobe。请将其 bin 目录加入 PATH，或设置 FFMPEG_DIR 后重启工具。' : `无法启动媒体工具：${error.message}`)
    })
    child.on('close', code => {
      clearTimeout(timeout)
      if (processError) reject(processError)
      else if (code === 0) resolve(stdout)
      else reject(new Error(`媒体处理失败，请检查文件、磁盘空间和输出权限。\n${stderr.slice(-1800)}`))
    })
  })
}

interface ProbeStream { codec_type: string; disposition?: { attached_pic?: number }; duration?: string; avg_frame_rate?: string; width?: number; height?: number }
export async function inspect(path: string, signal?: AbortSignal): Promise<Omit<MediaInfo, 'id' | 'url'>> {
  const raw = await run(executable('ffprobe'), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], undefined, signal)
  const info = JSON.parse(raw) as { format: { duration?: string }; streams: ProbeStream[] }
  const video = info.streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
  const duration = Number(info.format.duration || video?.duration)
  if (!video || !Number.isFinite(duration) || duration <= 0) throw new Error('文件没有可用的视频轨道或有效时长，请选择其他视频。')
  const [numerator, denominator] = String(video.avg_frame_rate).split('/').map(Number)
  return { name: basename(path), duration, width: Number(video.width), height: Number(video.height), fps: numerator / denominator || 0,
    hasAudio: info.streams.some(stream => stream.codec_type === 'audio') }
}

export async function clip(source: string, output: string, start: number, end: number, progress: (value: number) => void) {
  const info = await inspect(source)
  if (![start, end].every(Number.isFinite) || start < 0 || end > info.duration || start >= end) throw new Error('裁剪范围无效：起点必须小于终点，且不能超出视频时长。')
  try { await access(output); throw new Error('输出文件已存在，请选择新的文件名，工具不会覆盖已有文件。') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const temporary = join(dirname(output), `.clip-${randomUUID()}.mp4`)
  let published = false
  try {
    let pending = ''
    await run(executable('ffmpeg'), ['-hide_banner', '-nostdin', '-n', '-i', source,
      '-ss', String(start), '-t', String(end - start), '-map', '0:v:0', '-map', '0:a:0?',
      '-sn', '-dn', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', temporary], text => {
      pending += text
      const lines = pending.split('\n'); pending = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('out_time_us=')) continue
        const rawTime = line.slice('out_time_us='.length).trim()
        const elapsed = Number(rawTime)
        if (!rawTime || !Number.isFinite(elapsed)) continue
        const value = elapsed / ((end - start) * 1000000) * 100
        if (Number.isFinite(value)) progress(Math.min(99, Math.max(0, value)))
      }
    })
    const result = await inspect(temporary)
    // A hard link publishes atomically without replacing an existing file, including races.
    await link(temporary, output)
    published = true
    progress(100)
    return { ...result, name: basename(output) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('输出文件已存在，请选择新的文件名。')
    throw error
  } finally {
    await unlink(temporary).catch(() => {})
    if (!published) progress(0)
  }
}
export async function extractAudio(source: string, output: string, signal: AbortSignal) {
  const info = await inspect(source)
  if (!info.hasAudio) throw new Error('这个视频没有音轨，无法识别字幕。')
  if (info.duration > 7200) throw new Error('当前识别最多支持 2 小时的视频，请先裁剪缩短范围。')
  await run(executable('ffmpeg'), ['-hide_banner', '-nostdin', '-n', '-i', source, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output], undefined, signal)
  return info
}

export function normalizeYoutubeUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('请粘贴有效的 YouTube 视频链接。')
  let url: URL
  try { url = new URL(value.trim()) }
  catch { throw new Error('链接格式不正确，请粘贴完整的视频链接。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('请粘贴有效的 YouTube 视频链接。')
  const host = url.hostname.replace(/^www\./, '')
  const id = host === 'youtu.be' ? /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1]
    : ['youtube.com', 'm.youtube.com'].includes(host) ? (/^\/watch\/?$/.test(url.pathname) ? url.searchParams.get('v') : /^\/shorts\/([\w-]{11})\/?$/.exec(url.pathname)?.[1]) : undefined
  if (!id || !/^[\w-]{11}$/.test(id)) throw new Error('目前仅支持 YouTube 单个视频链接，暂不支持播放列表、频道和直播。')
  return `https://www.youtube.com/watch?v=${id}`
}

function runDownloadTool(tool: string, args: string[], signal: AbortSignal, timeoutMs: number, onLine?: (line: string) => void): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolveResult, reject) => {
    const child = spawn(tool, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', failure: Error | undefined, stopping = false, lastActivity = Date.now()
    const pending = { stdout: '', stderr: '' }
    const stop = (error: Error) => {
      failure ??= error
      if (stopping || !child.pid) return
      stopping = true
      if (process.platform === 'win32') {
        const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
        killer.once('error', () => child.kill())
        killer.once('exit', code => { if (code) child.kill() })
      } else child.kill('SIGKILL')
    }
    const abort = () => stop(new Error('下载已取消。'))
    const timeout = timeoutMs ? setTimeout(() => stop(new Error('视频解析超时，请检查网络后重试。')), timeoutMs) : undefined
    const idle = setInterval(() => { if (Date.now() - lastActivity > 10 * 60 * 1000) stop(new Error('下载长时间没有响应，请检查网络后重试。')) }, 5000)
    signal.addEventListener('abort', abort, { once: true })
    child.once('spawn', () => { if (signal.aborted) abort() })
    for (const channel of ['stdout', 'stderr'] as const) {
      child[channel].setEncoding('utf8')
      child[channel].on('data', (text: string) => {
        lastActivity = Date.now()
        if (channel === 'stderr') {
          stderr = (stderr + text).slice(-12000)
          if (!stopping && /HTTP Error 429|Too Many Requests/i.test(stderr)) {
            youtubeRateLimitUntil = Math.max(youtubeRateLimitUntil, Date.now() + 5 * 60 * 1000)
            stop(new Error('YouTube 返回 HTTP 429，当前访问被限流。程序已停止继续请求并暂停新请求 5 分钟；这不代表限制会在 5 分钟后解除。请先在同一网络的浏览器中确认能正常播放，必要时导入 YouTube Cookies 后再试。'))
          }
        }
        if (!onLine) {
          if (channel === 'stdout') {
            stdout += text
            if (stdout.length > 16 * 1024 * 1024) stop(new Error('视频信息过大，请更换单个视频链接。'))
          }
          return
        }
        pending[channel] += text
        if (pending[channel].length > 1024 * 1024) { stop(new Error('下载组件返回了异常数据，请检查工具版本。')); return }
        const lines = pending[channel].split(/\r?\n/)
        pending[channel] = lines.pop() || ''
        try { for (const line of lines) onLine(line) }
        catch { stop(new Error('无法读取下载进度，请检查下载组件版本。')) }
      })
    }
    child.once('error', error => { failure ??= new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? `未找到 ${basename(tool)}，请检查下载组件与 FFmpeg 配置。` : `无法启动下载组件：${error.message}`) })
    child.once('close', code => {
      clearTimeout(timeout)
      clearInterval(idle)
      signal.removeEventListener('abort', abort)
      if (onLine && !failure) {
        try { for (const line of Object.values(pending)) if (line) onLine(line) }
        catch { failure = new Error('无法读取下载结果，请检查下载组件版本。') }
      }
      if (failure) { reject(failure); return }
      if (signal.aborted) { reject(new Error('下载已取消。')); return }
      if (code === 0) { resolveResult(stdout); return }
      const detail = args.includes('--cookies') ? '' : stderr.replace(/https?:\/\/\S+/g, '[链接]').replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-1400)
      const message = /HTTP Error 429|Too Many Requests/i.test(stderr) ? 'YouTube 当前限制请求，请等待冷却后再试。'
        : /sign.?in|log.?in|cookies|not a bot|confirm your age/i.test(stderr) ? 'YouTube 要求验证当前访问会话。请先在同一网络的浏览器中完成验证；浏览器能播放时，可导入 YouTube Cookies 后重试。'
        : /requested format (?:is )?not available/i.test(stderr) ? '所选画质已不可用，请重新分析链接后选择。'
        : /private video|video unavailable|not available|removed|members.only|copyright/i.test(stderr) ? '视频不可用、受限或已删除，请更换链接。'
        : /HTTP Error 403/i.test(stderr) ? 'YouTube 拒绝访问或下载地址已失效，请稍后重试；已有分析结果时请重新分析链接。'
        : /timed? out|connection|network|proxy|resolve|unreachable/i.test(stderr) ? '网络连接失败，请检查网络或下载代理配置后重试。'
        : '下载或合并失败，请检查网络、磁盘空间和工具版本。'
      reject(new Error(`${message}${detail ? `\n${detail}` : ''}`))
    })
  })
}

async function runYoutubeTool(tool: string, args: string[], signal: AbortSignal, timeoutMs: number, onLine?: (line: string) => void, infoJson?: string) {
  while (true) {
    signal.throwIfAborted()
    const now = Date.now()
    if (youtubeRateLimitUntil > now) throw new Error(`YouTube 请求仍在冷却，约剩 ${Math.ceil((youtubeRateLimitUntil - now) / 1000)} 秒。程序没有再次访问视频；冷却结束后仍可能需要在浏览器验证并导入 YouTube Cookies。`)
    const wait = youtubeNextRequestAt - now
    if (wait <= 0) { youtubeNextRequestAt = now + 5000; break }
    await new Promise<void>((resolveWait, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolveWait() }, wait)
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('任务已取消。')) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  const cookies = youtubeCookies || '# Netscape HTTP Cookie File\n'
  const cookiesRevision = youtubeCookiesRevision
  let temporary: string | undefined, temporaryRoot = ''
  let toolError: unknown
  try {
    const options = [...args]
    temporaryRoot = await realpath(app.getPath('temp'))
    temporary = await mkdtemp(join(temporaryRoot, 'workbench-youtube-'))
    const cookiePath = join(temporary, 'cookies.txt')
    await writeFile(cookiePath, cookies, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    options.unshift('--cookies', cookiePath)
    if (infoJson) {
      const path = join(temporary, 'video.info.json')
      await writeFile(path, infoJson, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      options.unshift('--load-info-json', path)
    }
    signal.throwIfAborted()
    const result = await runDownloadTool(tool, options, signal, timeoutMs, onLine)
    if (!signal.aborted && cookiesRevision === youtubeCookiesRevision && temporary) setYoutubeCookies(await readFile(join(temporary, 'cookies.txt'), 'utf8'), true)
    return result
  } catch (error) { toolError = error; throw error }
  finally {
    if (temporary && dirname(resolve(temporary)) === resolve(temporaryRoot) && basename(temporary).startsWith('workbench-youtube-')) {
      try { await rm(temporary, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 }) }
      catch {
        const message = `临时验证文件未能清理，请在任务结束后删除：${temporary}`
        if (toolError instanceof Error) toolError.message += `\n${message}`
        else throw new Error(message)
      }
    }
  }
}

async function downloadToolOptions(signal: AbortSignal, checkMedia: boolean) {
  const tools = process.env.DOWNLOADER_DIR || (app.isPackaged ? join(process.resourcesPath, 'downloader') : join(__dirname, '../.packaging/downloader'))
  const downloader = join(tools, 'yt-dlp.exe'), deno = join(tools, 'deno.exe')
  const ffmpeg = executable('ffmpeg')
  await Promise.all([runDownloadTool(downloader, ['--version'], signal, 30000), runDownloadTool(deno, ['--version'], signal, 30000), ...(checkMedia ? [runDownloadTool(ffmpeg, ['-version'], signal, 30000), runDownloadTool(executable('ffprobe'), ['-version'], signal, 30000)] : [])])
  const args = ['--ignore-config', '--no-playlist', '--no-cache-dir', '--encoding', 'utf-8', '--socket-timeout', '30', '--retries', '3', '--fragment-retries', '3', '--extractor-retries', '0', '--sleep-requests', '1', '--js-runtimes', `deno:${deno}`]
  if (ffmpeg !== 'ffmpeg') args.push('--ffmpeg-location', dirname(ffmpeg))
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy
  if (proxy) {
    let address: URL
    try { address = new URL(proxy) } catch { throw new Error('下载代理格式无效，请使用完整的 HTTP、HTTPS 或 SOCKS 代理地址。') }
    if (!['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(address.protocol)) throw new Error('下载代理类型不支持。')
    args.push('--proxy', proxy)
  }
  return { downloader, args }
}

export interface YoutubeVideoAnalysis {
  url: string; title: string; duration?: number; hasAudio: boolean; qualities: DownloadQuality[]
  selections: Map<string, { format: string; width: number; height: number; fps?: number }>
  infoJson: string
}

export async function analyzeYoutubeVideo(value: string, signal: AbortSignal): Promise<YoutubeVideoAnalysis> {
  const url = normalizeYoutubeUrl(value)
  const { downloader, args } = await downloadToolOptions(signal, false)
  const raw = await runYoutubeTool(downloader, [...args, '--dump-single-json', '--skip-download', '--', url], signal, 120000)
  interface YoutubeFormat { format_id?: string; vcodec?: string; acodec?: string; width?: number; height?: number; fps?: number; dynamic_range?: string; has_drm?: boolean }
  const metadata = JSON.parse(raw) as { id?: string; title?: string; duration?: number; _type?: string; live_status?: string; formats?: YoutubeFormat[] }
  if (!metadata || typeof metadata !== 'object' || metadata.id !== new URL(url).searchParams.get('v') || (metadata._type && metadata._type !== 'video') || !Array.isArray(metadata.formats)) throw new Error('未能解析到单个视频，请检查链接。')
  if (['is_live', 'is_upcoming', 'post_live'].includes(metadata.live_status || '')) throw new Error('暂不支持正在直播、尚未开播或正在处理的直播视频。')
  const formats = metadata.formats.filter(format => format && !format.has_drm && typeof format.format_id === 'string' && /^[\w-]+$/.test(format.format_id))
  const hasAudio = formats.some(format => format.acodec && format.acodec !== 'none')
  const hasSeparateAudio = formats.some(format => format.vcodec === 'none' && format.acodec && format.acodec !== 'none')
  const groups = new Map<string, { quality: DownloadQuality; format: string }>()
  // yt-dlp returns formats in preference order; retain its preferred encoding within each quality group.
  for (const format of formats) {
    if (!format.vcodec || ['none', 'images'].includes(format.vcodec) || !Number.isFinite(format.width) || !Number.isFinite(format.height) || format.width! <= 0 || format.height! <= 0) continue
    if ((!format.acodec || format.acodec === 'none') && hasAudio && !hasSeparateAudio) continue
    const width = Math.round(format.width!), height = Math.round(format.height!)
    const fps = Number.isFinite(format.fps) && format.fps! > 0 ? Number(format.fps!.toFixed(2)) : undefined
    const dynamicRange = typeof format.dynamic_range === 'string' && format.dynamic_range && format.dynamic_range !== 'SDR' ? format.dynamic_range.slice(0, 30) : 'SDR'
    const label = `${Math.min(width, height)}p${fps ? ` · ${fps} fps` : ''}${dynamicRange !== 'SDR' ? ` · ${dynamicRange}` : ''}`
    groups.set(`${width}x${height}:${fps || 0}:${dynamicRange}`, { quality: { id: randomUUID(), label, width, height, fps, dynamicRange }, format: `${format.format_id}${(!format.acodec || format.acodec === 'none') && hasAudio ? '+ba' : ''}` })
  }
  const options = [...groups.values()].sort((a, b) => Math.min(b.quality.width, b.quality.height) - Math.min(a.quality.width, a.quality.height) || (b.quality.fps || 0) - (a.quality.fps || 0) || a.quality.dynamicRange.localeCompare(b.quality.dynamicRange))
  if (!options.length) throw new Error('没有找到可下载的视频画质，请检查链接或稍后重试。')
  return {
    url, infoJson: raw, title: String(metadata.title || metadata.id).slice(0, 500), duration: Number.isFinite(metadata.duration) && metadata.duration! > 0 ? metadata.duration : undefined,
    hasAudio, qualities: options.map(option => option.quality),
    selections: new Map(options.map(({ quality, format }) => [quality.id, { format, width: quality.width, height: quality.height, fps: quality.fps }]))
  }
}

export async function downloadVideo(url: string, selectedDirectory: string, signal: AbortSignal, update: (patch: Partial<DownloadJob>) => void, analyzed?: YoutubeVideoAnalysis, qualityId = 'best'): Promise<{ path: string; warning?: string }> {
  let directory = resolve(selectedDirectory)
  let temporary: string | undefined
  let result: { path: string; warning?: string } | undefined
  try {
    directory = await realpath(directory)
    const analysis = analyzed || await analyzeYoutubeVideo(url, signal)
    if (analysis.url !== normalizeYoutubeUrl(url)) throw new Error('分析结果与当前链接不一致，请重新分析。')
    const selection = qualityId === 'best' ? undefined : analysis.selections.get(qualityId)
    if (qualityId !== 'best' && !selection) throw new Error('所选画质已不可用，请重新分析链接后选择。')
    const { downloader, args: common } = await downloadToolOptions(signal, true)
    signal.throwIfAborted()
    temporary = await mkdtemp(join(directory, '.workbench-download-'))
    const title = analysis.title
    update({ status: 'downloading', title, message: '正在连接视频下载…' })
    let downloadedFile = ''
    const progressTemplate = 'download:WB_PROGRESS:{"downloaded":%(progress.downloaded_bytes|0)j,"total":%(progress.total_bytes,progress.total_bytes_estimate|0)j,"speed":%(progress.speed|0)j,"eta":%(progress.eta|0)j,"video":%(info.vcodec|none)j,"audio":%(info.acodec|none)j}'
    await runYoutubeTool(downloader, [...common, '--no-simulate', '--newline', '--no-colors', '--progress', '--progress-delta', '0.3', '--progress-template', progressTemplate, '--progress-template', 'postprocess:WB_PROCESS:%(progress.status)s', '--print', 'after_move:WB_FILE:%(filepath)j', '-f', selection?.format || (analysis.hasAudio ? 'bv*+ba/b' : 'bv*'), '-P', temporary, '-o', 'source.%(ext)s'], signal, 0, line => {
      if (line.startsWith('WB_PROGRESS:')) {
        const data = JSON.parse(line.slice('WB_PROGRESS:'.length)) as { downloaded: number; total: number; speed: number; eta: number; video: string; audio: string }
        const downloadedBytes = Number.isFinite(data.downloaded) && data.downloaded >= 0 ? data.downloaded : 0
        const totalBytes = Number.isFinite(data.total) && data.total > 0 ? data.total : undefined
        const stream = data.video === 'none' ? 'audio' : data.audio === 'none' ? 'video' : 'combined'
        update({ status: 'downloading', stream, message: stream === 'audio' ? '正在下载音频…' : stream === 'video' ? '正在下载视频…' : '正在下载音视频…', downloadedBytes, totalBytes, percent: totalBytes ? Math.min(99, downloadedBytes / totalBytes * 100) : undefined, speed: Number.isFinite(data.speed) && data.speed > 0 ? data.speed : undefined, eta: Number.isFinite(data.eta) && data.eta >= 0 ? data.eta : undefined })
      } else if (line.startsWith('WB_PROCESS:')) update({ status: 'processing', message: '正在合并和整理音视频…', percent: undefined, speed: undefined, eta: undefined })
      else if (line.startsWith('WB_FILE:')) downloadedFile = JSON.parse(line.slice('WB_FILE:'.length))
    }, analysis.infoJson)
    signal.throwIfAborted()
    update({ status: 'verifying', message: '正在检查视频信息…', percent: undefined, speed: undefined, eta: undefined })
    if (typeof downloadedFile !== 'string' || !downloadedFile || dirname(resolve(downloadedFile)) !== resolve(temporary) || !/^source\.[a-z0-9]{1,8}$/i.test(basename(downloadedFile))) throw new Error('下载组件未返回有效的输出文件。')
    const file = await realpath(downloadedFile)
    if (dirname(file).toLowerCase() !== resolve(temporary).toLowerCase() || !(await lstat(file)).isFile()) throw new Error('下载输出文件无效。')
    const info = await inspect(file, signal)
    if (analysis.hasAudio && !info.hasAudio) throw new Error('下载结果缺少音轨，请重试。')
    if (selection && (Math.min(info.width, info.height) !== Math.min(selection.width, selection.height) || Math.max(info.width, info.height) !== Math.max(selection.width, selection.height) || (selection.fps && Math.abs(info.fps - selection.fps) > 1))) throw new Error('下载结果与所选画质不一致，请重新分析链接后选择。')
    update({ actualResolution: `${info.width} × ${info.height}${info.fps > 0 ? ` · ${Number(info.fps.toFixed(2))} fps` : ''}` })
    signal.throwIfAborted()
    update({ status: 'saving', message: '正在保存最终视频…' })
    let safeTitle = [...title.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')].slice(0, 100).join('').replace(/[. ]+$/g, '').trim() || 'YouTube 视频'
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(safeTitle)) safeTitle = `_${safeTitle}`
    for (let index = 0; index < 10000; index++) {
      const output = join(directory, `${safeTitle} [${new URL(url).searchParams.get('v')}]${index ? ` (${index})` : ''}${extname(file)}`)
      try {
        try { await link(file, output) }
        catch (error) {
          if (!['EPERM', 'ENOTSUP', 'EXDEV', 'EINVAL', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code || '')) throw error
          await copyFile(file, output, constants.COPYFILE_EXCL)
        }
        result = { path: output }
        return result
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    throw new Error('同名文件过多，请选择其他下载目录。')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOSPC') throw new Error('磁盘空间不足，请清理空间或更换下载目录。')
    if (code === 'EACCES' || code === 'EPERM') throw new Error('无法写入下载目录，请检查权限或选择其他目录。')
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error('下载目录或工具不存在，请重新选择目录并检查工具配置。')
    throw error
  } finally {
    if (temporary && dirname(resolve(temporary)) === resolve(directory) && basename(temporary).startsWith('.workbench-download-')) {
      try { await rm(temporary, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 }) }
      catch {
        const warning = `临时文件未能清理，可在任务结束后手动删除：${temporary}`
        if (result) result.warning = warning
        else update({ warning })
      }
    }
  }
}
