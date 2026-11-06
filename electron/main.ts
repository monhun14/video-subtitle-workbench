import { app, BrowserWindow, ipcMain, dialog, protocol, shell } from 'electron'
import { join, resolve, extname, basename, dirname } from 'node:path'
import { stat, mkdtemp, unlink, rmdir, open, readFile, mkdir, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import * as media from './media'
import type { IpcMap, MediaInfo, SubtitleJob, SubtitleReview, TranslationSource, TranslationJob } from '../src/env'
import { loadSettings, getSettings, saveSettings, getCredentials } from './settings'
import { credentialFingerprint, recognizeAudio, validateRecognition, toSrt, type RemoteTask } from './speech'
import { parseSrt, translatePending, validateTranslation } from './translation'

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])
const files = new Map<string, string>()
const outputs = new Set<string>()
const outputSuggestions = new Map<string, string>()
let window: BrowserWindow
let busy = false
const mediaInfos = new Map<string, MediaInfo>()
const subtitleJobs = new Map<string, SubtitleJob>()
const recognitionControllers = new Map<string, AbortController>()
const remoteTasks = new Map<string, RemoteTask>()
const translationSources = new Map<string, { source: TranslationSource; directory: string }>()
const translationJobs = new Map<string, TranslationJob>()
let translating: { id: string; controller: AbortController } | undefined

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
  const result = { ...info, id, url: `media://local/${id}` }
  mediaInfos.set(id, result)
  return result
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
  window.on('close', event => { if (busy || recognitionControllers.size || translating) { event.preventDefault(); dialog.showMessageBoxSync(window, { message: '正在处理视频或字幕，请等待完成或停止字幕任务后关闭窗口。' }) } })
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
    if (!input || typeof input.id !== 'string' || typeof input.language !== 'string' || !mediaInfos.has(input.id)) throw new Error('请先导入视频，再生成原文字幕。')
    if (recognitionControllers.has(input.id)) throw new Error('这个视频正在识别，请等待或停止当前任务。')
    if (recognitionControllers.size >= 2) throw new Error('当前已有两个识别任务，请等待其中一个结束。')
    const credentials = getCredentials()
    validateRecognition(input.provider, input.language, credentials)
    const video = mediaInfos.get(input.id)!
    if (!video.hasAudio) throw new Error('这个视频没有音轨，无法识别字幕。')
    const previousJob = subtitleJobs.get(input.id)
    const previous = previousJob?.result
    const controller = new AbortController()
    recognitionControllers.set(input.id, controller)
    const job: SubtitleJob = { mediaId: input.id, provider: input.provider, language: input.language, model: input.provider === 'aliyun' ? credentials.aliyun.model : undefined, recognitionId: randomUUID(), status: 'extracting', message: '正在提取视频音频…', result: previous, review: previousJob?.review }
    subtitleJobs.set(input.id, job)
    const publish = () => { if (!window.isDestroyed()) window.webContents.send('subtitles:job', job) }
    publish()
    let temporary: string | undefined
    let rawResultMessage = ''
    let review: SubtitleReview[] = []
    const timeout = setTimeout(() => controller.abort(new Error('识别等待超过 20 分钟，已停止本地等待。阿里云任务可在本次打开期间重试查询。')), 20 * 60 * 1000)
    try {
      const savedTask = remoteTasks.get(input.id)
      const resume = input.provider === 'aliyun' && savedTask?.fingerprint === credentialFingerprint(credentials.aliyun, input.language) ? savedTask : undefined
      let audioPath: string | undefined
      if (!resume) {
        temporary = await mkdtemp(join(app.getPath('temp'), 'workbench-audio-'))
        audioPath = join(temporary, 'audio.wav')
        await media.extractAudio(files.get(input.id)!, audioPath, controller.signal)
      }
      const cues = await recognizeAudio({ audioPath, duration: video.duration, provider: input.provider, language: input.language, credentials, signal: controller.signal, resume,
        stage: (status, message) => { job.status = status; job.message = message; publish() },
        onRemote: task => { if (task) remoteTasks.set(input.id, task); else remoteTasks.delete(input.id) },
        onReview: items => { review = items },
        onRawResult: app.isPackaged ? undefined : async text => {
          const directory = join(app.getPath('userData'), 'asr-debug')
          const path = join(directory, `aliyun-${Date.now()}-${randomUUID()}.json`)
          try {
            await mkdir(directory, { recursive: true })
            await writeFile(path, text, { encoding: 'utf8', flag: 'wx' })
            rawResultMessage = `云端原始结果已保存：${path}`
          } catch (error) {
            rawResultMessage = `云端原始结果保存失败：${path}\n${error instanceof Error ? error.message : '无法写入调试文件。'}`
          }
        }
      })
      controller.signal.throwIfAborted()
      job.result = cues.length || !previous ? { provider: input.provider, language: input.language, model: job.model, recognitionId: job.recognitionId, cues, createdAt: new Date().toISOString() } : previous
      job.status = 'succeeded'
      job.review = review
      job.message = review.length ? `识别完成，可用字幕 ${cues.length} 条，另有 ${review.length} 条待校对（未纳入本次导出与翻译）。${!cues.length && previous ? ' 本次未生成可用字幕，已有字幕已保留。' : ''}`
        : cues.length ? `识别完成，共 ${cues.length} 条原文字幕。` : previous ? '没有识别到说话内容，已有字幕已保留。' : '没有识别到说话内容，请检查音频或尝试指定语言。'
    } catch (error) {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed'
      job.message = controller.signal.aborted ? (controller.signal.reason instanceof Error ? controller.signal.reason.message : '识别已停止。') : error instanceof Error ? error.message : '字幕识别失败，请重试。'
      if (previousJob) { job.model = previousJob.model; job.recognitionId = previousJob.recognitionId }
      if (previous) job.message += ' 已有字幕已保留。'
    } finally {
      clearTimeout(timeout)
      if (temporary) {
        await unlink(join(temporary, 'audio.wav')).catch(() => {})
        await rmdir(temporary).catch(() => {})
      }
      recognitionControllers.delete(input.id)
      if (!app.isPackaged && rawResultMessage) job.message += `\n${rawResultMessage}`
      publish()
    }
    return job
  })
  handle('subtitles:cancel', async id => {
    if (typeof id !== 'string' || !recognitionControllers.has(id)) throw new Error('这个视频没有正在进行的识别任务。')
    recognitionControllers.get(id)!.abort(new Error('已停止本地识别等待；已提交的云端任务可能继续处理并计费。'))
  })
  handle('subtitles:review', async input => {
    if (!input || typeof input.mediaId !== 'string' || typeof input.reviewId !== 'string' || !['accept', 'discard'].includes(input.action)) throw new Error('校对操作无效。')
    if (recognitionControllers.has(input.mediaId)) throw new Error('请先等待或停止这个视频的识别，再处理待校对字幕。')
    const job = subtitleJobs.get(input.mediaId)
    const video = mediaInfos.get(input.mediaId)
    const item = job?.review?.find(review => review.id === input.reviewId)
    if (!job || !video || !item || item.status) throw new Error('该条待校对字幕已处理或已更新，请查看最新结果。')
    if (input.action === 'accept') {
      if (typeof input.start !== 'number' || typeof input.end !== 'number' || !Number.isFinite(input.start) || !Number.isFinite(input.end) || input.start < 0) throw new Error('请输入有效的开始和结束时间。')
      const start = Math.round(input.start * 1000) / 1000
      const end = Math.round(input.end * 1000) / 1000
      if (end <= start) throw new Error('结束时间必须大于开始时间，最短为 1 毫秒。')
      if (Math.round(end * 1000) > Math.round(video.duration * 1000)) throw new Error('校对时间不能超出视频时长。')
      if (!item.text.trim()) throw new Error('该条没有可加入的字幕文字，可选择废弃。')
      const transcript = job.result?.recognitionId === job.recognitionId && job.result ? job.result : { provider: job.provider, language: job.language, model: job.model, recognitionId: job.recognitionId, cues: [], createdAt: new Date().toISOString() }
      job.result = { ...transcript, createdAt: new Date().toISOString(), cues: [...transcript.cues, { start, end, text: item.text.trim(), ...(item.speakerId !== undefined ? { speakerId: item.speakerId } : {}) }].sort((a, b) => a.start - b.start || a.end - b.end) }
      item.corrected = { start, end }
      item.status = 'accepted'
    } else item.status = 'discarded'
    const pending = job.review!.filter(review => !review.status).length
    const accepted = job.review!.filter(review => review.status === 'accepted').length
    const discarded = job.review!.filter(review => review.status === 'discarded').length
    const rawNotice = app.isPackaged ? '' : job.message.split('\n').filter(line => line.startsWith('云端原始结果')).join('\n')
    job.status = 'succeeded'
    job.message = `校对已更新，可用字幕 ${job.result?.cues.length ?? 0} 条，待校对 ${pending} 条，已加入 ${accepted} 条，已废弃 ${discarded} 条。${rawNotice ? `\n${rawNotice}` : ''}`
    if (!window.isDestroyed()) window.webContents.send('subtitles:job', job)
    return job
  })
  handle('subtitles:export', async input => {
    const id = typeof input === 'string' ? input : input?.mediaId
    const source = typeof id === 'string' ? files.get(id) : undefined
    const transcript = subtitleJobs.get(id)?.result
    if (!source || !transcript?.cues.length) throw new Error('这个视频尚无可导出的字幕，请先生成字幕。')
    let cues = transcript.cues
    let label = '原文'
    if (typeof input !== 'string') {
      if (input.speakerId !== null && (typeof input.speakerId !== 'number' || !Number.isSafeInteger(input.speakerId) || input.speakerId < 0)) throw new Error('说话人分组无效，请重新选择。')
      if (transcript.provider !== 'aliyun' || !['qwen-audio-3.1-asr-flash-filetrans', 'fun-asr'].includes(transcript.model ?? '')) throw new Error('这份识别结果不支持按说话人导出。')
      if (recognitionControllers.has(id)) throw new Error('请等待或停止当前识别后再导出说话人字幕。')
      if ((input.recognitionId !== undefined && typeof input.recognitionId !== 'string') || input.recognitionId !== transcript.recognitionId) throw new Error('识别结果已更新，请重新展开说话人分组后导出。')
      cues = cues.filter(cue => {
        const known = typeof cue.speakerId === 'number' && Number.isSafeInteger(cue.speakerId) && cue.speakerId >= 0
        return input.speakerId === null ? !known : known && cue.speakerId === input.speakerId
      })
      if (!cues.length) throw new Error('这个说话人分组尚无可导出的字幕，请查看最新识别结果。')
      label = input.speakerId === null ? '未识别说话人' : `说话人${input.speakerId + 1}`
    }
    const srt = toSrt(cues)
    const result = await dialog.showSaveDialog(window, { title: `导出${label} SRT 字幕`, defaultPath: join(dirname(source), `${basename(source, extname(source))}-${label}.srt`), filters: [{ name: 'SRT 字幕', extensions: ['srt'] }] })
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
  handle('translation:source', async input => {
    if (translating) throw new Error('请先等待或停止当前翻译，再切换字幕来源。')
    if (!input || !['recognized', 'imported'].includes(input.kind)) throw new Error('字幕来源无效。')
    let source: TranslationSource
    let directory: string
    if (input.kind === 'recognized') {
      const transcript = subtitleJobs.get(input.mediaId)?.result
      const video = files.get(input.mediaId)
      if (!transcript?.cues.length || !video) throw new Error('这个视频暂无有效的识别字幕。')
      if (transcript.cues.length > 2000 || transcript.cues.some(cue => cue.text.length > 8000)) throw new Error('字幕超过单次翻译限制：最多 2000 条，每条最多 8000 字符。')
      source = { id: randomUUID(), kind: 'recognized', name: `${basename(video, extname(video))}-原文.srt`, cues: structuredClone(transcript.cues) }
      directory = dirname(video)
    } else {
      const selected = await dialog.showOpenDialog(window, { title: '选择需要翻译的 SRT', properties: ['openFile'], filters: [{ name: 'SRT 字幕', extensions: ['srt'] }] })
      if (selected.canceled) return null
      const path = selected.filePaths[0]
      if (extname(path).toLowerCase() !== '.srt' || (await stat(path)).size > 5 * 1024 * 1024) throw new Error('请选择不超过 5MB 的 SRT 文件。')
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)) }
      catch { throw new Error('SRT 读取失败或不是 UTF-8 编码，请另存为 UTF-8 后导入。') }
      source = { id: randomUUID(), kind: 'imported', name: basename(path), cues: parseSrt(text) }
      directory = dirname(path)
    }
    translationSources.set(source.id, { source, directory })
    return source
  })
  handle('translation:start', async input => {
    if (translating) throw new Error('当前已有翻译任务，请等待或停止后再开始。')
    const selected = input && translationSources.get(input.sourceId)
    if (!selected) throw new Error('请先选择当前识别字幕或导入 SRT。')
    const credentials = getCredentials()
    const model = validateTranslation(input.provider, input.targetLanguage, credentials)
    let job = input.retryJobId ? translationJobs.get(input.retryJobId) : undefined
    if (input.retryJobId && (!job || job.source.id !== input.sourceId || job.provider !== input.provider || job.targetLanguage !== input.targetLanguage || job.model !== model || job.status === 'running' || job.status === 'completed')) throw new Error('重试任务与当前来源或配置不一致，请开始新的翻译任务。')
    job ??= { id: randomUUID(), source: structuredClone(selected.source), provider: input.provider, targetLanguage: input.targetLanguage, model, status: 'running', translations: selected.source.cues.map(() => null), errors: selected.source.cues.map(() => ''), completed: 0, message: '正在准备翻译…' }
    translationJobs.set(job.id, job)
    const controller = new AbortController()
    translating = { id: job.id, controller }
    const publish = () => { if (!window.isDestroyed()) window.webContents.send('translation:job', job) }
    const timeout = setTimeout(() => controller.abort(), 30 * 60 * 1000)
    try { await translatePending(job, credentials, controller.signal, publish) }
    catch { job.status = controller.signal.aborted ? 'cancelled' : 'partial'; job.message = '翻译未能完成，已有结果已保留，可重试未完成部分。'; publish() }
    finally { clearTimeout(timeout); translating = undefined }
    return job
  })
  handle('translation:cancel', async id => {
    if (!translating || translating.id !== id) throw new Error('这个翻译任务没有正在运行。')
    translating.controller.abort()
  })
  handle('translation:export', async input => {
    const job = input && translationJobs.get(input.jobId)
    if (!job || job.status !== 'completed' || job.translations.some(text => !text) || !['translated', 'bilingual'].includes(input.format)) throw new Error('请等待全部字幕翻译完成，再导出译文或双语 SRT。')
    const cues = job.source.cues.map((cue, index) => ({ ...cue, text: input.format === 'bilingual' ? `${cue.text}\n${job.translations[index]}` : job.translations[index]! }))
    const name = `${basename(job.source.name, extname(job.source.name))}-${input.format === 'bilingual' ? '双语' : '译文'}-${job.targetLanguage}.srt`
    const selected = await dialog.showSaveDialog(window, { title: input.format === 'bilingual' ? '导出双语 SRT' : '导出译文 SRT', defaultPath: join(translationSources.get(job.source.id)!.directory, name), filters: [{ name: 'SRT 字幕', extensions: ['srt'] }] })
    if (selected.canceled || !selected.filePath) return null
    const path = extname(selected.filePath).toLowerCase() === '.srt' ? selected.filePath : `${selected.filePath}.srt`
    let file
    try {
      file = await open(path, 'wx')
      await file.writeFile(`\uFEFF${toSrt(cues)}`, 'utf8')
      await file.close()
      return path
    } catch (error) {
      if (file) { await file.close().catch(() => {}); await unlink(path).catch(() => {}) }
      throw new Error((error as NodeJS.ErrnoException).code === 'EEXIST' ? '文件已存在，请另选名称，不会覆盖原文或已有译文。' : '字幕导出失败，请检查磁盘空间和输出权限。')
    }
  })
  await window.loadURL('http://127.0.0.1:5173')
})
app.on('window-all-closed', () => app.quit())
