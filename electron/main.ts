import { app, BrowserWindow, ipcMain, dialog, protocol, shell } from 'electron'
import { join, resolve, extname, basename, dirname } from 'node:path'
import { stat, mkdtemp, unlink, rmdir, open } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import * as media from './media'
import type { IpcMap, MediaInfo, SubtitleJob } from '../src/env'
import { loadSettings, getSettings, saveSettings, getCredentials } from './settings'
import { credentialFingerprint, recognizeAudio, validateRecognition, toSrt, type RemoteTask } from './speech'

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])
const files = new Map<string, string>()
const outputs = new Set<string>()
const outputSuggestions = new Map<string, string>()
let window: BrowserWindow
let busy = false
const clips = new Map<string, MediaInfo>()
const subtitleJobs = new Map<string, SubtitleJob>()
const recognitionControllers = new Map<string, AbortController>()
const remoteTasks = new Map<string, RemoteTask>()

async function availableOutput(path: string, advance: boolean) {
  const match = /^((?:.*-)?片段)([1-9]\d*)(\.mp4)$/i.exec(basename(path))
  if (!match) return path
  let number = BigInt(match[2]) + (advance ? 1n : 0n)
  const protectedPaths = new Set([...files.values()].map(file => resolve(file).toLowerCase()))
  while (true) {
    const candidate = join(dirname(path), `${match[1]}${number}${match[3]}`)
    if (!protectedPaths.has(resolve(candidate).toLowerCase())) {
      try { await stat(candidate) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
        throw error
      }
    }
    number++
  }
}

async function register(path: string) {
  const info = await media.inspect(path)
  const id = randomUUID()
  files.set(id, path)
  return { ...info, id, url: `media://local/${id}` }
}

function handle<K extends keyof IpcMap>(channel: K, action: (...args: IpcMap[K]['args']) => Promise<IpcMap[K]['result']>) {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: '请求来源无效。' }
    try { return { ok: true, value: await action(...args as IpcMap[K]['args']) } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : '操作失败，请重试。' } }
  })
}

app.whenReady().then(async () => {
  await loadSettings()
  protocol.handle('media', async request => {
    const url = new URL(request.url)
    const path = url.hostname === 'local' && files.get(url.pathname.slice(1))
    if (!path) return new Response('Not found', { status: 404 })
    try {
      const { size } = await stat(path)
      const range = request.headers.get('range')
      let start = 0, end = size - 1
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range)
        if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
        end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
        if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      const mime: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' }
      const headers = new Headers({ 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Content-Type': mime[extname(path).toLowerCase()] || 'application/octet-stream' })
      if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
      return new Response(request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers })
    } catch { return new Response('File unavailable', { status: 404 }) }
  })
  window = new BrowserWindow({ width: 1200, height: 820, minWidth: 850, minHeight: 650, backgroundColor: '#10151f',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.on('close', event => { if (busy || recognitionControllers.size) { event.preventDefault(); dialog.showMessageBoxSync(window, { message: '正在处理视频或识别字幕，请等待完成或停止识别后关闭窗口。' }) } })
  handle('settings:get', async () => getSettings())
  handle('settings:save', async input => saveSettings(input))
  handle('video:import', async () => {
    if (busy) throw new Error('请等待当前裁剪完成。')
    const result = await dialog.showOpenDialog(window, { title: '导入本地视频', properties: ['openFile'], filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mts', 'ts'] }] })
    return result.canceled ? null : register(result.filePaths[0])
  })
  handle('video:output', async id => {
    if (busy) throw new Error('请等待当前裁剪完成。')
    const source = files.get(id)
    if (!source) throw new Error('请先导入视频。')
    const defaultPath = await availableOutput(outputSuggestions.get(id) || join(app.getPath('videos'), `${basename(source, extname(source))}-片段1.mp4`), false)
    const result = await dialog.showSaveDialog(window, { title: '选择新的 MP4 输出文件', defaultPath, filters: [{ name: 'MP4 视频', extensions: ['mp4'] }] })
    if (result.canceled || !result.filePath) return null
    const path = extname(result.filePath).toLowerCase() === '.mp4' ? result.filePath : `${result.filePath}.mp4`
    if ([...files.values()].some(file => resolve(file).toLowerCase() === resolve(path).toLowerCase())) throw new Error('请选择新的文件名，不能覆盖源视频或已打开的结果。')
    outputs.add(path)
    outputSuggestions.set(id, path)
    return path
  })
  handle('video:clip', async input => {
    if (busy) throw new Error('已有裁剪任务正在进行。')
    if (!input || typeof input.id !== 'string' || typeof input.output !== 'string' || !files.has(input.id) || !outputs.has(input.output)) throw new Error('请先导入视频并选择输出位置。')
    busy = true
    try {
      await media.clip(files.get(input.id)!, input.output, input.start, input.end, value => { if (!window.isDestroyed()) window.webContents.send('video:progress', value) })
      const result = await register(input.output)
      clips.set(result.id, result)
      let nextOutput = ''
      let nextOutputWarning
      try {
        nextOutput = await availableOutput(input.output, true)
        outputs.add(nextOutput)
        outputSuggestions.set(input.id, nextOutput)
      } catch {
        outputSuggestions.delete(input.id)
        nextOutputWarning = '片段已保存，但无法准备下一个输出名称。请重新选择输出位置。'
      }
      return { ...result, nextOutput, nextOutputWarning }
    } finally { busy = false }
  })
  handle('video:reveal', async id => {
    const path = files.get(id)
    if (!path) throw new Error('文件不可用，请重新导入。')
    shell.showItemInFolder(path)
  })
  handle('subtitles:recognize', async input => {
    if (!input || typeof input.id !== 'string' || typeof input.language !== 'string' || !clips.has(input.id)) throw new Error('请先裁剪一个片段，再为该片段生成字幕。')
    if (recognitionControllers.has(input.id)) throw new Error('这个片段正在识别，请等待或停止当前任务。')
    if (recognitionControllers.size >= 2) throw new Error('当前已有两个识别任务，请等待其中一个结束。')
    const credentials = getCredentials()
    validateRecognition(input.provider, input.language, credentials)
    const clip = clips.get(input.id)!
    if (!clip.hasAudio) throw new Error('这个片段没有音轨，无法识别字幕。')
    const previous = subtitleJobs.get(input.id)?.result
    const controller = new AbortController()
    recognitionControllers.set(input.id, controller)
    const job: SubtitleJob = { mediaId: input.id, provider: input.provider, language: input.language, status: 'extracting', message: '正在提取片段音频…', result: previous }
    subtitleJobs.set(input.id, job)
    const publish = () => { if (!window.isDestroyed()) window.webContents.send('subtitles:job', job) }
    publish()
    let temporary: string | undefined
    const timeout = setTimeout(() => controller.abort(new Error('识别等待超过 20 分钟，已停止本地等待。阿里云任务可在本次打开期间重试查询。')), 20 * 60 * 1000)
    try {
      const savedTask = remoteTasks.get(input.id)
      const resume = input.provider === 'aliyun' && savedTask?.fingerprint === credentialFingerprint(credentials.aliyun, input.language) ? savedTask : undefined
      let audioPath: string | undefined
      if (!resume) {
        temporary = await mkdtemp(join(app.getPath('temp'), 'workbench-audio-'))
        audioPath = join(temporary, 'clip.wav')
        await media.extractAudio(files.get(input.id)!, audioPath, controller.signal)
      }
      const cues = await recognizeAudio({ audioPath, duration: clip.duration, provider: input.provider, language: input.language, credentials, signal: controller.signal, resume,
        stage: (status, message) => { job.status = status; job.message = message; publish() },
        onRemote: task => { if (task) remoteTasks.set(input.id, task); else remoteTasks.delete(input.id) }
      })
      controller.signal.throwIfAborted()
      job.result = cues.length || !previous ? { provider: input.provider, language: input.language, cues, createdAt: new Date().toISOString() } : previous
      job.status = 'succeeded'
      job.message = cues.length ? `识别完成，共 ${cues.length} 条原文字幕。` : previous ? '没有识别到说话内容，已有字幕已保留。' : '没有识别到说话内容，请检查音频或尝试指定语言。'
    } catch (error) {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed'
      job.message = controller.signal.aborted ? (controller.signal.reason instanceof Error ? controller.signal.reason.message : '识别已停止。') : error instanceof Error ? error.message : '字幕识别失败，请重试。'
      if (previous) job.message += ' 已有字幕已保留。'
    } finally {
      clearTimeout(timeout)
      if (temporary) {
        await unlink(join(temporary, 'clip.wav')).catch(() => {})
        await rmdir(temporary).catch(() => {})
      }
      recognitionControllers.delete(input.id)
      publish()
    }
    return job
  })
  handle('subtitles:cancel', async id => {
    if (typeof id !== 'string' || !recognitionControllers.has(id)) throw new Error('这个片段没有正在进行的识别任务。')
    recognitionControllers.get(id)!.abort(new Error('已停止本地识别等待；已提交的云端任务可能继续处理并计费。'))
  })
  handle('subtitles:export', async id => {
    const source = typeof id === 'string' ? files.get(id) : undefined
    const transcript = subtitleJobs.get(id)?.result
    if (!source || !transcript?.cues.length) throw new Error('这个片段尚无可导出的字幕，请先生成字幕。')
    const srt = toSrt(transcript.cues)
    const result = await dialog.showSaveDialog(window, { title: '导出原文 SRT 字幕', defaultPath: join(dirname(source), `${basename(source, extname(source))}-原文.srt`), filters: [{ name: 'SRT 字幕', extensions: ['srt'] }] })
    if (result.canceled || !result.filePath) return null
    const path = extname(result.filePath).toLowerCase() === '.srt' ? result.filePath : `${result.filePath}.srt`
    let file
    try {
      file = await open(path, 'wx')
      await file.writeFile(`\uFEFF${srt}`, 'utf8')
      await file.close()
      return path
    } catch (error) {
      if (file) { await file.close().catch(() => {}); await unlink(path).catch(() => {}) }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('字幕文件已存在，请选择新的名称，工具不会覆盖已有文件。')
      throw new Error('字幕导出失败，请检查磁盘空间和输出目录的写入权限。')
    }
  })
  await window.loadURL('http://127.0.0.1:5173')
})
app.on('window-all-closed', () => app.quit())
