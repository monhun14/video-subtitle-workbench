import { randomUUID, createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { Credentials } from './settings'
import type { AliyunRecognitionModel, Provider, SubtitleCue, SubtitleReview } from '../src/env'

const volcLanguages: Record<string, string> = { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR', yue: 'yue-CN', fr: 'fr-FR', de: 'de-DE', es: 'es-MX', pt: 'pt-BR', ru: 'ru-RU', it: 'it-IT', ar: 'ar-SA', id: 'id-ID', ms: 'ms-MY', th: 'th-TH', vi: 'vi-VN', fil: 'fil-PH', tr: 'tr-TR', uk: 'uk-UA', pl: 'pl-PL' }
export interface RemoteTask { id: string; fingerprint: string }
type Transport = (url: string, options: RequestInit) => Promise<Response>
interface CloudBody {
  code?: string
  data?: Record<string, string>
  output?: { task_id?: string; task_status?: string; code?: string; result?: { transcription_url?: string }; results?: { subtask_status?: string; transcription_url?: string; code?: string }[] }
  transcripts?: { sentences?: unknown[] }[]
  result?: { text?: string; utterances?: unknown[] }
}

export class RequestError extends Error {
  constructor(message: string, readonly diagnosticCode: string, readonly httpStatus?: number) { super(message) }
}

export async function request(url: string, options: RequestInit, signal: AbortSignal, transport: Transport, timeout = 120000) {
  let response: Response
  const requestTimeout = AbortSignal.timeout(timeout)
  try { response = await transport(url, { ...options, redirect: 'error', signal: AbortSignal.any([signal, requestTimeout]) }) }
  catch (error) {
    if (signal.aborted) throw new Error('识别已停止。')
    let code = requestTimeout.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR'
    const knownCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED'])
    const pending: unknown[] = [error]
    for (let count = 0; pending.length && count < 12; count++) {
      const value = pending.shift()
      if (!value || typeof value !== 'object') continue
      const cause = value as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown; errors?: unknown[] }
      if (typeof cause.code === 'string' && knownCodes.has(cause.code)) { code = cause.code; break }
      if (cause.name === 'TimeoutError') code = 'REQUEST_TIMEOUT'
      if (cause.message === 'unexpected redirect') code = 'REDIRECT_BLOCKED'
      if (cause.cause) pending.push(cause.cause)
      if (Array.isArray(cause.errors)) pending.push(...cause.errors)
    }
    throw new RequestError('连接失败或请求超时，请检查网络、代理和系统证书。', code)
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new RequestError('服务鉴权失败，请检查所选地域、凭证和模型开通权限。', `HTTP_${response.status}`, response.status)
    if (response.status === 429) throw new RequestError('服务调用过于频繁或额度不足，请检查控制台后稍后重试。', 'HTTP_429', 429)
    throw new RequestError('服务请求失败，请检查识别配置和服务状态。', `HTTP_${response.status}`, response.status)
  }
  return response
}

async function json(response: Response): Promise<CloudBody> {
  try {
    const body: unknown = await response.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid JSON object')
    return body as CloudBody
  }
  catch { throw new RequestError('识别服务返回了无法解析的数据，请稍后重试。', 'INVALID_RESPONSE') }
}

export function normalizeCues(rows: unknown, duration: number): SubtitleCue[] {
  if (!Array.isArray(rows)) throw new Error('识别结果缺少分句时间轴，无法生成字幕。')
  const cues: SubtitleCue[] = []
  for (const value of rows as unknown[]) {
    if (!value || typeof value !== 'object') throw new Error('识别结果中的字幕数据无效。')
    const row = value as { text?: unknown; begin_time?: unknown; start_time?: unknown; end_time?: unknown; speaker_id?: unknown }
    if (typeof row.text !== 'string') throw new Error('识别结果中的字幕文本无效。')
    const text = row.text.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n').replace(/\0/g, '').trim()
    if (!text) continue
    const from = row.begin_time ?? row.start_time
    const to = row.end_time
    if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !Number.isFinite(to) || to < from || from < 0 || to > duration * 1000 + 1000) throw new Error('识别结果包含无效或越界的字幕时间，需校对时间轴。')
    if (to === from) throw new Error('云端返回的整句起止时间相同，需校对时间轴。')
    const start = Math.round(from) / 1000
    const end = Math.min(Math.round(to), Math.round(duration * 1000)) / 1000
    if (end <= start) throw new Error('识别结果包含超出视频范围的字幕时间。')
    cues.push({ start, end, text, ...(typeof row.speaker_id === 'number' && Number.isSafeInteger(row.speaker_id) && row.speaker_id >= 0 ? { speakerId: row.speaker_id } : {}) })
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end)
}

function splitSubtitleText(text: string): string[] {
  const sentences: string[] = []
  let from = 0
  for (const match of text.matchAll(/([。！？!?．.]+)(["'”’»」』）)\]】〕〉》]*)/gu)) {
    const index = match.index!
    if (/^[.．]$/u.test(match[1])) {
      const before = text[index - 1] ?? ''
      const after = text[index + 1] ?? ''
      const prefix = text.slice(0, index + 1)
      if ((/[A-Za-z\p{N}]/u.test(before) && /[A-Za-z\p{N}]/u.test(after)) || /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|No|Inc|Ltd|Co|e\.g|i\.e)|\b[A-Za-z]|\b(?:[A-Za-z]\.)+[A-Za-z])\.$/iu.test(prefix)) continue
    }
    const end = index + match[0].length
    const sentence = text.slice(from, end).trim()
    if (!/[^\s\p{P}]/u.test(sentence)) continue
    sentences.push(sentence)
    from = end
  }
  const remaining = text.slice(from).trim()
  if (remaining) {
    if (sentences.length && !/[^\s\p{P}]/u.test(remaining)) sentences[sentences.length - 1] += remaining
    else sentences.push(remaining)
  }
  return sentences
}

function splitAliyunCues(rows: unknown[], duration: number, review: SubtitleReview[]): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  for (const [index, value] of rows.entries()) {
    let original: SubtitleCue | undefined
    try {
      original = normalizeCues([value], duration)[0]
      if (!original) continue
      const row = value as { words?: unknown }
      let text = original.text
      let sentences = splitSubtitleText(text)
      const wordText = Array.isArray(row.words) ? row.words.map(word => `${typeof word?.text === 'string' ? word.text : ''}${typeof word?.punctuation === 'string' ? word.punctuation : ''}`).join(' ') : ''
      // Sentence timestamps remain usable even when individual words have zero duration.
      if (sentences.length <= 1 && splitSubtitleText(wordText).length <= 1) {
        cues.push(original)
        continue
      }
      const characters = [...text.matchAll(/[^\s\p{P}]/gu)]
      const words: { from: number; to: number; start: number; end: number; punctuation: string }[] = []
      if (Array.isArray(row.words) && row.words.length) {
        let offset = 0
        for (const item of row.words as unknown[]) {
          if (!item || typeof item !== 'object') throw new Error('字词数据格式无效，无法继续分句。')
          const word = item as { text?: unknown; punctuation?: unknown; begin_time?: unknown; end_time?: unknown }
          if (typeof word.text !== 'string' || (word.punctuation !== undefined && (typeof word.punctuation !== 'string' || !/^[\s\p{P}]*$/u.test(word.punctuation)))) throw new Error('字词文字或标点格式无效，无法继续分句。')
          const body = word.text.replace(/[\s\p{P}]/gu, '')
          const length = Array.from(body).length
          let punctuation = word.text.match(/[\s\p{P}]+$/u)?.[0].trim() ?? ''
          if (typeof word.punctuation === 'string' && !punctuation.includes(word.punctuation.trim())) punctuation += word.punctuation.trim()
          const previous = words.at(-1)
          if (!length) {
            if (previous && !previous.punctuation.includes(punctuation)) previous.punctuation += punctuation
            continue
          }
          if (characters.slice(offset, offset + length).map(character => character[0]).join('') !== body) throw new Error('字词文字与原文不匹配，无法继续分句。')
          const start = word.begin_time
          const end = word.end_time
          if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > duration * 1000 + 1000) throw new Error('字词时间无效或越界，无法继续分句。')
          words.push({ from: offset, to: offset + length, start, end, punctuation })
          offset += length
        }
        if (offset !== characters.length) throw new Error('字词文字未覆盖完整原文，无法继续分句。')
        // Keep the original spacing and punctuation; fill punctuation supplied only on words.
        for (let index = words.length - 1; index >= 0; index--) {
          const word = words[index]
          const last = characters[word.to - 1]
          const position = last.index! + last[0].length
          const gap = text.slice(position, characters[word.to]?.index ?? text.length)
          if (word.punctuation && !/\p{P}/u.test(gap.replace(/["'”’»」』）)\]】〕〉》]/gu, ''))) {
            let punctuation = word.punctuation
            const existing = gap.replace(/\s/gu, '')
            for (let overlap = Math.min(punctuation.length, existing.length); overlap > 0; overlap--) {
              if (!punctuation.endsWith(existing.slice(0, overlap))) continue
              punctuation = punctuation.slice(0, -overlap)
              break
            }
            text = text.slice(0, position) + punctuation + text.slice(position)
          }
        }
      }
      sentences = splitSubtitleText(text)
      if (!words.length) {
        cues.push(original)
        continue
      }
      const splitCues: SubtitleCue[] = []
      let offset = 0
      let wordIndex = 0
      for (const sentence of sentences) {
        const end = offset + Array.from(sentence.replace(/[\s\p{P}]/gu, '')).length
        const first = words[wordIndex]
        while (wordIndex < words.length && words[wordIndex].to < end) wordIndex++
        const last = words[wordIndex]
        // A boundary inside one timed word cannot be split accurately without realignment.
        if (!first || !last || first.from !== offset || last.to !== end) throw new Error('句末未落在字词时间边界上，无法准确分句。')
        splitCues.push({ start: first.start / 1000, end: last.end / 1000, text: sentence, ...(original.speakerId !== undefined ? { speakerId: original.speakerId } : {}) })
        offset = end
        wordIndex++
      }
      cues.push(...normalizeCues(splitCues.map(cue => ({ text: cue.text, begin_time: cue.start * 1000, end_time: cue.end * 1000, speaker_id: cue.speakerId })), duration))
    } catch (error) {
      // A usable sentence timeline is enough; keep it when finer alignment is unavailable.
      if (original) {
        cues.push(original)
        continue
      }
      const row = value as { text?: unknown; begin_time?: unknown; end_time?: unknown; speaker_id?: unknown } | null
      review.push({
        id: randomUUID(),
        sourceIndex: index + 1,
        text: typeof row?.text === 'string' ? row.text : '',
        start: typeof row?.begin_time === 'number' && Number.isFinite(row.begin_time) ? row.begin_time / 1000 : undefined,
        end: typeof row?.end_time === 'number' && Number.isFinite(row.end_time) ? row.end_time / 1000 : undefined,
        ...(typeof row?.speaker_id === 'number' && Number.isSafeInteger(row.speaker_id) && row.speaker_id >= 0 ? { speakerId: row.speaker_id } : {}),
        reason: error instanceof Error ? error.message : '此条字幕无法解析，需校对。',
        raw: value
      })
    }
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function toSrt(cues: SubtitleCue[]): string {
  return cues.map((cue, index) => {
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || !cue.text.trim()) throw new Error('字幕内容或时间无效，无法导出。')
    const times = [cue.start, cue.end].map(seconds => {
      const ms = Math.round(seconds * 1000)
      const hours = String(Math.floor(ms / 3600000)).padStart(2, '0')
      const minutes = String(Math.floor(ms / 60000) % 60).padStart(2, '0')
      const remaining = String(Math.floor(ms / 1000) % 60).padStart(2, '0')
      return `${hours}:${minutes}:${remaining},${String(ms % 1000).padStart(3, '0')}`
    })
    return `${index + 1}\r\n${times[0]} --> ${times[1]}\r\n${cue.text.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n').replace(/\n/g, '\r\n')}\r\n`
  }).join('\r\n')
}

export function validateRecognition(provider: Provider, language: string, credentials: Credentials) {
  if (!['aliyun', 'volcengine'].includes(provider) || (language !== 'auto' && !Object.hasOwn(volcLanguages, language))) throw new Error('请选择有效的识别服务商和语言。')
  if (provider === 'aliyun' ? !credentials.aliyun.apiKey : credentials.volcengine.mode === 'apiKey' ? !credentials.volcengine.apiKey : !(credentials.volcengine.appId && credentials.volcengine.accessToken)) throw new Error('请先在“识别服务设置”中配置所选服务商的凭证。')
  if (provider === 'aliyun') {
    if (!['qwen3-asr-flash-filetrans', 'qwen-audio-3.1-asr-flash-filetrans', 'fun-asr'].includes(credentials.aliyun.model)) throw new Error('请选择有效的阿里云识别模型。')
    if (credentials.aliyun.model !== 'qwen3-asr-flash-filetrans' && ['tr', 'uk'].includes(language)) throw new Error('所选阿里云识别模型不支持该语言，请选择自动识别或其他语言。')
  }
}

function aliyunRecognitionParameters(model: AliyunRecognitionModel, language: string) {
  if (model === 'qwen3-asr-flash-filetrans') {
    return { channel_id: [0], enable_itn: false, enable_words: true, ...(language === 'auto' ? {} : { language }) }
  }
  return {
    channel_id: [0], diarization_enabled: true,
    ...(language === 'auto' ? {} : { language_hints: [language === 'fil' ? 'tl' : language === 'yue' ? 'zh' : language] }),
    ...(model === 'qwen-audio-3.1-asr-flash-filetrans' && language === 'yue' ? { keep_dialect: true } : {})
  }
}

export function credentialFingerprint(credentials: Credentials['aliyun'], language: string) {
  return createHash('sha256').update(JSON.stringify({ ...credentials, language, parameters: aliyunRecognitionParameters(credentials.model, language) })).digest('hex')
}

export async function recognizeAudio(input: {
  audioPath?: string; duration: number; provider: Provider; language: string; credentials: Credentials
  signal: AbortSignal; stage: (status: 'uploading' | 'recognizing', message: string) => void
  resume?: RemoteTask; onRemote: (task?: RemoteTask) => void
  onRawResult?: (text: string) => Promise<void>
  onReview?: (items: SubtitleReview[]) => void
}, transport: Transport = fetch): Promise<SubtitleCue[]> {
  const { signal, language, provider, credentials, stage } = input
  validateRecognition(provider, language, credentials)
  const ali = credentials.aliyun
  const model = ali.model
  const fingerprint = credentialFingerprint(ali, language)
  const region = ali.region === 'beijing' ? 'cn-beijing' : 'ap-southeast-1'
  const legacyHost = ali.region === 'beijing' ? 'dashscope.aliyuncs.com' : 'dashscope-intl.aliyuncs.com'
  const base = `https://${ali.workspaceId ? `${ali.workspaceId}.${region}.maas.aliyuncs.com` : legacyHost}/api/v1`
  const headers = { Authorization: `Bearer ${ali.apiKey}`, 'Content-Type': 'application/json' }
  let task = input.resume?.fingerprint === fingerprint ? input.resume : undefined
  const diagnostic: { phase: string; host: string; submission: 'none' | 'unknown' | 'confirmed' | 'completed' | 'failed' } = {
    phase: '读取视频音频', host: '本地', submission: provider === 'aliyun' && task ? 'confirmed' : 'none'
  }
  try {
    if (provider === 'aliyun' && task) stage('recognizing', '继续查询已提交的识别任务，无需重复上传。')
    else {
      if (!input.audioPath) throw new Error('未找到待识别的视频音频，请重新生成字幕。')
      const size = (await stat(input.audioPath)).size
      if (size > 100 * 1024 * 1024) throw new Error('提取的音频超过 100MB，请先裁剪缩短视频后重试。')
      const bytes = await readFile(input.audioPath)
      stage('uploading', '正在上传此视频的音频…')
      if (provider === 'volcengine') {
        const volc = credentials.volcengine
        const auth: Record<string, string> = volc.mode === 'apiKey' ? { 'X-Api-Key': volc.apiKey } : { 'X-Api-App-Key': volc.appId, 'X-Api-Access-Key': volc.accessToken }
        stage('recognizing', '正在上传并识别视频音频，请稍候…')
        diagnostic.phase = '火山引擎上传并识别音频'
        diagnostic.host = 'openspeech.bytedance.com'
        diagnostic.submission = 'unknown'
        const response = await request('https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash', {
          method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Api-Resource-Id': 'volc.bigasr.auc_turbo', 'X-Api-Request-Id': randomUUID(), 'X-Api-Sequence': '-1' },
          body: JSON.stringify({ user: { uid: 'video-subtitle-workbench' }, audio: { data: bytes.toString('base64'), format: 'wav', rate: 16000, bits: 16, channel: 1, ...(language === 'auto' ? {} : { language: volcLanguages[language] }) },
            request: { model_name: 'bigmodel', show_utterances: true, enable_itn: false, enable_punc: true, enable_ddc: false, ...(language === 'auto' ? { enable_auto_lang: true } : {}) } })
        }, signal, transport, 10 * 60 * 1000)
        const code = response.headers.get('X-Api-Status-Code')
        if (code === '20000003') return []
        if (code !== '20000000') {
          diagnostic.submission = 'failed'
          throw new RequestError('火山引擎识别失败，请检查豆包语音凭证、极速版开通权限和账户额度。', code && /^\d{8}$/.test(code) ? `VOLC_${code}` : 'INVALID_STATUS')
        }
        diagnostic.submission = 'completed'
        diagnostic.phase = '解析火山引擎字幕结果'
        const body = await json(response)
        if (body.result?.text === '' && (!body.result.utterances || !body.result.utterances.length)) return []
        return normalizeCues(body.result?.utterances, input.duration)
      }
      diagnostic.phase = '申请阿里云音频上传凭证'
      diagnostic.host = legacyHost
      stage('uploading', '正在申请阿里云音频上传凭证…')
      const policy = (await json(await request(`https://${legacyHost}/api/v1/uploads?action=getPolicy&model=${model}`, { headers }, signal, transport))).data
      if (!policy || ['upload_dir', 'upload_host', 'policy', 'signature', 'oss_access_key_id', 'x_oss_object_acl', 'x_oss_forbid_overwrite'].some(key => typeof policy[key] !== 'string' || !policy[key])) throw new Error('阿里云未返回有效的音频上传凭证，请检查模型权限。')
      const uploadHost = new URL(policy.upload_host)
      if (uploadHost.protocol !== 'https:' || !uploadHost.hostname.endsWith('.aliyuncs.com')) throw new Error('阿里云返回的上传地址无效。')
      const filename = `${randomUUID()}.wav`
      const key = `${policy.upload_dir}/${filename}`
      const form = new FormData()
      for (const [name, value] of Object.entries({ OSSAccessKeyId: policy.oss_access_key_id, Signature: policy.signature, policy: policy.policy, 'x-oss-object-acl': policy.x_oss_object_acl, 'x-oss-forbid-overwrite': policy.x_oss_forbid_overwrite, key, success_action_status: '200' })) form.append(name, value)
      form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), filename)
      diagnostic.phase = '上传音频至阿里云 OSS'
      diagnostic.host = uploadHost.hostname
      stage('uploading', '正在上传视频音频至阿里云 OSS…')
      await request(uploadHost.href, { method: 'POST', body: form }, signal, transport)
      stage('recognizing', '音频已上传，正在提交识别任务…')
      diagnostic.phase = '提交阿里云识别任务'
      diagnostic.host = new URL(base).hostname
      diagnostic.submission = 'unknown'
      const submitted = await json(await request(`${base}/services/audio/asr/transcription`, { method: 'POST', headers: { ...headers, 'X-DashScope-Async': 'enable', 'X-DashScope-OssResourceResolve': 'enable' },
        body: JSON.stringify({ model, input: model === 'qwen3-asr-flash-filetrans' ? { file_url: `oss://${key}` } : { file_urls: [`oss://${key}`] }, parameters: aliyunRecognitionParameters(model, language) }) }, signal, transport))
      const id = submitted.output?.task_id
      if (typeof id !== 'string' || !id) throw new Error('阿里云未返回识别任务，请检查模型权限和账户额度。')
      task = { id, fingerprint }
      diagnostic.submission = 'confirmed'
      input.onRemote(task)
    }
    if (!task) throw new Error('识别任务未能创建，请重试。')
    for (let attempt = 0; attempt < 400; attempt++) {
      signal.throwIfAborted()
      diagnostic.phase = '查询阿里云识别任务'
      diagnostic.host = new URL(base).hostname
      const body = await json(await request(`${base}/tasks/${encodeURIComponent(task.id)}`, { headers }, signal, transport))
      const status = body.output?.task_status
      if (status === 'SUCCEEDED') {
        diagnostic.submission = 'completed'
        let resultUrl = body.output?.result?.transcription_url
        if (model !== 'qwen3-asr-flash-filetrans') {
          const results = body.output?.results
          if (!Array.isArray(results) || results.length !== 1 || !results[0]) throw new Error('识别结果中的音频子任务数据无效，稍后重试可重新获取。')
          const result = results[0]
          if (result.subtask_status === 'FAILED') {
            diagnostic.submission = 'failed'
            input.onRemote(undefined)
            throw new RequestError('阿里云音频转写子任务失败，请检查音频、模型权限和账户额度后重试。', typeof result.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(result.code) ? result.code : 'SUBTASK_FAILED')
          }
          if (result.subtask_status !== 'SUCCEEDED') throw new Error('音频转写子任务尚未成功，稍后重试可继续获取结果。')
          resultUrl = result.transcription_url
        }
        if (typeof resultUrl !== 'string') throw new Error('识别已完成，但未返回字幕下载地址。再次点击可重新获取结果。')
        const url = new URL(resultUrl)
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.endsWith('.aliyuncs.com')) throw new Error('识别服务返回了无效的字幕下载地址。')
        url.protocol = 'https:'
        diagnostic.phase = '下载阿里云字幕结果'
        diagnostic.host = url.hostname
        stage('recognizing', '云端识别已完成，正在下载字幕结果…')
        const transcriptResponse = await request(url.href, {}, signal, transport)
        // Temporary diagnostic capture: save the complete response before JSON parsing or alignment.
        if (input.onRawResult) await input.onRawResult(await transcriptResponse.clone().text())
        const transcript = await json(transcriptResponse)
        diagnostic.phase = '解析阿里云字幕时间轴'
        if (!Array.isArray(transcript.transcripts)) throw new Error('识别结果缺少字幕数据，请稍后重试。')
        if (transcript.transcripts.some(part => !Array.isArray(part.sentences))) throw new Error('识别结果缺少分句时间轴，请稍后重试。')
        const review: SubtitleReview[] = []
        const cues = splitAliyunCues(transcript.transcripts.flatMap(part => part.sentences ?? []), input.duration, review)
        input.onReview?.(review)
        input.onRemote(undefined)
        return cues
      }
      if (status === 'FAILED' || status === 'UNKNOWN' || status === 'CANCELED') {
        diagnostic.submission = 'failed'
        input.onRemote(undefined)
        throw new Error('阿里云识别任务失败或已失效，请检查额度及服务权限后重试。')
      }
      if (status !== 'PENDING' && status !== 'RUNNING') throw new Error('识别服务返回未知任务状态，稍后重试可继续查询。')
      stage('recognizing', status === 'PENDING' ? '识别任务正在云端排队…' : '云端正在识别片段音频…')
      await delay(3000, undefined, { signal })
    }
    throw new Error('等待识别结果超时。再次点击可继续查询已提交的阿里云任务。')
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof RequestError && error.httpStatus && error.httpStatus >= 400 && error.httpStatus < 500 && diagnostic.submission === 'unknown') diagnostic.submission = 'none'
    const code = error instanceof RequestError ? error.diagnosticCode : 'INVALID_RESULT'
    const detail = error instanceof Error ? error.message : '处理失败，请重试。'
    const submission = {
      none: '尚未提交识别任务。',
      unknown: '未确认任务是否提交成功；重试可能重复计费。',
      confirmed: '任务已提交。本次打开期间保持相同配置重试，将继续查询原任务。',
      completed: provider === 'aliyun' ? '云端识别已完成。本次打开期间可重试获取结果。' : '服务已返回识别结果，但本地处理失败；重试会重新识别，可能再次计费。',
      failed: '服务已返回任务失败或无效状态，请检查配置后重试。'
    }[diagnostic.submission]
    throw new Error(`${diagnostic.phase}失败。${detail}\n目标主机：${diagnostic.host}\n诊断码：${code}\n${submission}`)
  }
}
