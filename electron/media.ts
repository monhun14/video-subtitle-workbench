import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { access, unlink, link } from 'node:fs/promises'
import type { MediaInfo } from '../src/env'

function executable(name: 'ffmpeg' | 'ffprobe') {
  const directory = process.env.FFMPEG_DIR
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
export async function inspect(path: string): Promise<Omit<MediaInfo, 'id' | 'url'>> {
  const raw = await run(executable('ffprobe'), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path])
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
  if (!info.hasAudio) throw new Error('这个片段没有音轨，无法识别字幕。')
  if (info.duration > 7200) throw new Error('当前识别最多支持 2 小时的片段，请先缩短范围。')
  await run(executable('ffmpeg'), ['-hide_banner', '-nostdin', '-n', '-i', source, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output], undefined, signal)
  return info
}
