import { app, BrowserWindow, ipcMain, dialog, protocol, shell } from 'electron'
import { join, resolve, extname, basename, dirname } from 'node:path'
import { stat, mkdtemp, unlink, rmdir, open, readFile, mkdir, writeFile } from 'node:fs/promises'
import { createReadStream, mkdirSync } from 'node:fs'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import * as media from './media'
import type { IpcMap, MediaInfo, SubtitleJob, SubtitleReview, TranslationSource, TranslationJob, DownloadJob, DownloadAnalysis } from '../src/env'
import { loadSettings, getSettings, saveSettings, getCredentials } from './settings'
import { credentialFingerprint, recognizeAudio, validateRecognition, toSrt, type RemoteTask } from './speech'
import { parseSrt, translatePending, validateTranslation } from './translation'

const userDataDirectory = app.commandLine.getSwitchValue('user-data-dir') || join(app.getPath('appData'), 'video-subtitle-workbench')
mkdirSync(userDataDirectory, { recursive: true })
app.setPath('userData', userDataDirectory)
app.setName('切片字幕机')
app.setAppUserModelId('com.monhun14.video-subtitle-workbench')

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])
const files = new Map<string, string>()
const outputs = new Set<string>()
const outputSuggestions = new Map<string, string>()
let lastSaveDirectory = ''
let lastDownloadDirectory = ''
let downloadJob: DownloadJob | undefined
let downloading: { id: string; controller: AbortController } | undefined
let downloadAnalysis: DownloadAnalysis | undefined
let analyzedVideo: media.YoutubeVideoAnalysis | undefined
let downloadCookiesName = ''
let analyzing: { id: string; controller: AbortController } | undefined
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

function publishDownloadAnalysis(analysis: DownloadAnalysis, patch: Partial<DownloadAnalysis>) {
  if (downloadAnalysis?.id !== analysis.id) return
  Object.assign(analysis, patch)
  analysis.revision++
  if (!window.isDestroyed()) window.webContents.send('download:analysis', analysis)
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
  window = new BrowserWindow({ title: '切片字幕机', icon: join(__dirname, app.isPackaged ? '../dist/app-icon.ico' : '../public/app-icon.ico'), width: 1200, height: 820, minWidth: 850, minHeight: 650, backgroundColor: '#10151f',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.on('close', event => { if (busy || recognitionControllers.size || translating || downloading || analyzing) { event.preventDefault(); dialog.showMessageBoxSync(window, { message: '正在处理视频、分析、下载或字幕任务，请等待完成或停止任务后关闭窗口。' }) } })
  handle('settings:get', async () => getSettings())
  handle('settings:save', async input => saveSettings(input))
  handle('download:directory', async () => {
    if (downloading) throw new Error('请等待下载完成或取消后，再更改目录。')
    const selected = await dialog.showOpenDialog(window, { title: '选择源视频下载目录', defaultPath: lastDownloadDirectory || app.getPath('downloads'), properties: ['openDirectory'] })
    if (selected.canceled || !selected.filePaths[0]) return null
    if (downloading) throw new Error('下载已开始，目录未更改。')
    lastDownloadDirectory = selected.filePaths[0]
    return lastDownloadDirectory
  })
  handle('download:get', async () => {
    if (downloadAnalysis?.status === 'ready' && (downloadAnalysis.expiresAt || 0) <= Date.now()) {
      analyzedVideo = undefined
      publishDownloadAnalysis(downloadAnalysis, { status: 'failed', message: '分析结果已过期，请重新分析链接。', qualities: [] })
    }
    return { directory: lastDownloadDirectory, cookiesName: downloadCookiesName, job: downloadJob ? structuredClone(downloadJob) : undefined, analysis: downloadAnalysis ? structuredClone(downloadAnalysis) : undefined }
  })
  handle('download:cookies', async () => {
    if (downloading || analyzing) throw new Error('请等待下载或分析结束后，再更换验证会话。')
    const selected = await dialog.showOpenDialog(window, { title: '选择 YouTube Cookies 文件（Netscape 格式）', properties: ['openFile'], filters: [{ name: 'Cookies 文件', extensions: ['txt'] }] })
    if (selected.canceled || !selected.filePaths[0]) return null
    if (downloading || analyzing) throw new Error('任务已开始，验证会话未更改。')
    const path = selected.filePaths[0]
    if ((await stat(path)).size > 1024 * 1024) throw new Error('Cookies 文件不能超过 1MB。')
    const contents = await readFile(path)
    if (contents.length > 1024 * 1024) throw new Error('Cookies 文件不能超过 1MB。')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(contents) }
    catch { throw new Error('Cookies 文件不是有效的 UTF-8 文本，请重新导出。') }
    if (downloading || analyzing) throw new Error('任务已开始，验证会话未更改。')
    media.setYoutubeCookies(text)
    downloadCookiesName = basename(path)
    analyzedVideo = undefined
    downloadAnalysis = undefined
    if (downloadJob?.status !== 'succeeded') downloadJob = undefined
    return downloadCookiesName
  })
  handle('download:cookies-clear', async () => {
    if (downloading || analyzing) throw new Error('请等待下载或分析结束后，再移除验证会话。')
    media.setYoutubeCookies()
    downloadCookiesName = ''
    analyzedVideo = undefined
    downloadAnalysis = undefined
    if (downloadJob?.status !== 'succeeded') downloadJob = undefined
  })
  handle('download:analyze', async input => {
    if (downloading) throw new Error('请等待当前下载完成或取消后，再分析链接。')
    const url = media.normalizeYoutubeUrl(input?.url)
    if (!input.force && downloadAnalysis?.status === 'ready' && downloadAnalysis.url === url && (downloadAnalysis.expiresAt || 0) > Date.now() && analyzedVideo) return structuredClone(downloadAnalysis)
    analyzing?.controller.abort()
    const controller = new AbortController()
    const analysis: DownloadAnalysis = { id: randomUUID(), revision: 0, url, status: 'analyzing', message: '正在分析视频及可用画质…', qualities: [] }
    downloadAnalysis = analysis
    analyzedVideo = undefined
    analyzing = { id: analysis.id, controller }
    void media.analyzeYoutubeVideo(url, controller.signal).then(video => {
      if (controller.signal.aborted || downloadAnalysis?.id !== analysis.id) return
      analyzedVideo = video
      publishDownloadAnalysis(analysis, { status: 'ready', message: '分析完成，请选择画质后下载。', title: video.title, duration: video.duration, qualities: video.qualities, expiresAt: Date.now() + 10 * 60 * 1000 })
    }).catch(error => {
      publishDownloadAnalysis(analysis, { status: controller.signal.aborted ? 'cancelled' : 'failed', message: controller.signal.aborted ? '分析已取消。' : error instanceof Error ? error.message : '分析失败，请重试。', qualities: [] })
    }).finally(() => { if (analyzing?.id === analysis.id) analyzing = undefined })
    return structuredClone(analysis)
  })
  handle('download:analysis-cancel', async id => {
    if (analyzing?.id !== id || downloadAnalysis?.id !== id || downloadAnalysis.status !== 'analyzing') return
    analyzing.controller.abort()
    publishDownloadAnalysis(downloadAnalysis, { status: 'cancelled', message: '正在停止分析…', qualities: [] })
  })
  handle('download:start', async input => {
    if (downloading) throw new Error('已有下载任务，请等待完成或取消后再试。')
    const url = media.normalizeYoutubeUrl(input?.url)
    if (typeof input.autoBest !== 'boolean') throw new Error('下载选项无效，请重新提交。')
    if (!lastDownloadDirectory) throw new Error('请先选择下载目录。')
    let video: media.YoutubeVideoAnalysis | undefined
    let qualityId = 'best', quality = '最佳可用'
    if (!input.autoBest) {
      if (!input.analysisId || downloadAnalysis?.id !== input.analysisId || downloadAnalysis.url !== url || downloadAnalysis.status !== 'ready' || !analyzedVideo) throw new Error('请先分析当前链接，再选择画质下载。')
      if ((downloadAnalysis.expiresAt || 0) <= Date.now()) {
        analyzedVideo = undefined
        publishDownloadAnalysis(downloadAnalysis, { status: 'failed', message: '分析结果已过期，请重新分析链接。', qualities: [] })
        throw new Error('分析结果已过期，请重新分析链接。')
      }
      qualityId = input.qualityId || 'best'
      const option = downloadAnalysis.qualities.find(item => item.id === qualityId)
      if (qualityId !== 'best' && (!option || !analyzedVideo.selections.has(qualityId))) throw new Error('所选画质无效，请重新分析链接后选择。')
      quality = option ? `${option.label}（${option.width} × ${option.height}）` : '最佳可用'
      video = analyzedVideo
    } else {
      if (downloadAnalysis?.status === 'ready' && downloadAnalysis.url === url && (downloadAnalysis.expiresAt || 0) > Date.now()) video = analyzedVideo
      if (analyzing) {
        analyzing.controller.abort()
        if (downloadAnalysis?.id === analyzing.id) publishDownloadAnalysis(downloadAnalysis, { status: 'cancelled', message: '已切换为直接下载。', qualities: [] })
      }
      if (downloadAnalysis && downloadAnalysis.url !== url) { downloadAnalysis = undefined; analyzedVideo = undefined }
    }
    const controller = new AbortController()
    const job: DownloadJob = { id: randomUUID(), revision: 0, url, directory: lastDownloadDirectory, status: 'resolving', message: video ? '正在检查工具并准备下载所选画质…' : '正在检查下载工具并解析视频…', autoBest: input.autoBest, qualityId, quality }
    downloadJob = job
    downloading = { id: job.id, controller }
    const publish = (patch: Partial<DownloadJob>) => {
      Object.assign(job, patch)
      job.revision++
      if (!window.isDestroyed()) window.webContents.send('download:job', job)
    }
    void (async () => {
      const resolved = video || await media.analyzeYoutubeVideo(url, controller.signal)
      controller.signal.throwIfAborted()
      if (!video) {
        analyzedVideo = resolved
        downloadAnalysis = { id: randomUUID(), revision: 0, url, status: 'ready', message: '分析完成，正在下载最佳可用画质。', title: resolved.title, duration: resolved.duration, qualities: resolved.qualities, expiresAt: Date.now() + 10 * 60 * 1000 }
        publishDownloadAnalysis(downloadAnalysis, {})
      }
      return media.downloadVideo(url, job.directory, controller.signal, patch => {
        if (!controller.signal.aborted) publish(patch)
        else if (patch.warning) publish({ warning: patch.warning })
      }, resolved, qualityId)
    })().then(result => {
      publish({ status: 'succeeded', message: '下载完成，可导入为源视频。', percent: 100, output: result.path, warning: result.warning, speed: undefined, eta: undefined })
    }).catch(error => {
      publish({ status: controller.signal.aborted ? 'cancelled' : 'failed', message: controller.signal.aborted ? '下载已取消，可重新下载。' : error instanceof Error ? error.message : '下载失败，请重试。', speed: undefined, eta: undefined })
      if (!controller.signal.aborted && downloadAnalysis?.url === url && /所选画质已不可用|下载结果与所选画质不一致|下载地址已失效/.test(job.message)) {
        analyzedVideo = undefined
        publishDownloadAnalysis(downloadAnalysis, { status: 'failed', message: '画质或下载地址已失效，请重新分析链接后选择；若仍被拒绝访问，请检查验证会话。', qualities: [] })
      }
    }).finally(() => { downloading = undefined })
    return structuredClone(job)
  })
  handle('download:cancel', async id => {
    if (!downloading || downloading.id !== id || downloadJob?.id !== id) throw new Error('这个下载任务没有正在运行。')
    if (downloadJob.status === 'saving') throw new Error('正在保存最终文件，请等待保存完成。')
    if (downloadJob.status === 'cancelling') return
    downloadJob.status = 'cancelling'
    downloadJob.message = '正在停止下载并清理临时文件…'
    downloadJob.revision++
    downloading.controller.abort()
    if (!window.isDestroyed()) window.webContents.send('download:job', downloadJob)
  })
  handle('download:reveal', async id => {
    if (downloadJob?.id !== id || downloadJob.status !== 'succeeded' || !downloadJob.output) throw new Error('下载文件不可用。')
    await stat(downloadJob.output)
    shell.showItemInFolder(downloadJob.output)
  })
  handle('download:import', async id => {
    if (busy) throw new Error('请等待当前裁剪完成后再导入视频。')
    if (downloadJob?.id !== id || downloadJob.status !== 'succeeded' || !downloadJob.output) throw new Error('请等待下载完成后再导入。')
    return register(downloadJob.output)
  })
  handle('video:import', async () => {
    if (busy) throw new Error('请等待当前裁剪完成。')
    const result = await dialog.showOpenDialog(window, { title: '导入本地视频', properties: ['openFile'], filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mts', 'ts'] }] })
    return result.canceled ? null : register(result.filePaths[0])
  })
  handle('video:output', async id => {
    if (busy) throw new Error('请等待当前裁剪完成。')
    const source = files.get(id)
    if (!source) throw new Error('请先导入视频。')
    const suggestion = outputSuggestions.get(id) || join(app.getPath('videos'), `${basename(source, extname(source))}-片段1.mp4`)
    const defaultPath = await availableOutput(lastSaveDirectory ? join(lastSaveDirectory, basename(suggestion)) : suggestion, false)
    const result = await dialog.showSaveDialog(window, { title: '选择新的 MP4 输出文件', defaultPath, filters: [{ name: 'MP4 视频', extensions: ['mp4'] }] })
    if (result.canceled || !result.filePath) return null
    const path = extname(result.filePath).toLowerCase() === '.mp4' ? result.filePath : `${result.filePath}.mp4`
    if ([...files.values()].some(file => resolve(file).toLowerCase() === resolve(path).toLowerCase())) throw new Error('请选择新的文件名，不能覆盖源视频或已打开的结果。')
    lastSaveDirectory = dirname(path)
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
    const result = await dialog.showSaveDialog(window, { title: `导出${label} SRT 字幕`, defaultPath: join(lastSaveDirectory || dirname(source), `${basename(source, extname(source))}-${label}.srt`), filters: [{ name: 'SRT 字幕', extensions: ['srt'] }] })
    if (result.canceled || !result.filePath) return null
    const path = extname(result.filePath).toLowerCase() === '.srt' ? result.filePath : `${result.filePath}.srt`
    lastSaveDirectory = dirname(path)
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
    const remaining = job.translations.filter(value => value === null).length
    const timeoutMs = input.provider === 'aliyun' ? Math.min(2 * 60 * 60 * 1000, Math.max(30 * 60 * 1000, remaining * 3000 + 10 * 60 * 1000)) : 30 * 60 * 1000
    const timeout = setTimeout(() => controller.abort(new DOMException('翻译任务已达到时间上限。', 'TimeoutError')), timeoutMs)
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
    const selected = await dialog.showSaveDialog(window, { title: input.format === 'bilingual' ? '导出双语 SRT' : '导出译文 SRT', defaultPath: join(lastSaveDirectory || translationSources.get(job.source.id)!.directory, name), filters: [{ name: 'SRT 字幕', extensions: ['srt'] }] })
    if (selected.canceled || !selected.filePath) return null
    const path = extname(selected.filePath).toLowerCase() === '.srt' ? selected.filePath : `${selected.filePath}.srt`
    lastSaveDirectory = dirname(path)
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
  if (app.isPackaged) await window.loadFile(join(__dirname, '../dist/index.html'))
  else await window.loadURL('http://127.0.0.1:5173')
})
app.on('window-all-closed', () => app.quit())
