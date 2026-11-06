<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import type { MediaInfo, Provider, SettingsStatus, SettingsUpdate, SubtitleCue, SubtitleJob, SubtitleReview, SubtitleReviewInput, TranslationSource, TranslationJob } from './env'

const source = ref<MediaInfo | null>(null)
interface MediaRecord { kind: 'source' | 'clip'; media: MediaInfo; source: MediaInfo; start: number; end: number; output?: string; provider: Provider; language: string; job?: SubtitleJob; subtitlesOpen: boolean; speakersOpen?: boolean; exportMessage?: string }
const results = ref<MediaRecord[]>([])
const speakerGroups = computed(() => {
  const groupsByMedia: Record<string, { count: number; groups: { speakerId?: number; label: string; cues: SubtitleCue[] }[] }> = {}
  for (const record of results.value) {
    const speakers = new Map<number, SubtitleCue[]>()
    const unknown: SubtitleCue[] = []
    for (const cue of record.job?.result?.cues ?? []) {
      if (typeof cue.speakerId !== 'number' || !Number.isSafeInteger(cue.speakerId) || cue.speakerId < 0) { unknown.push(cue); continue }
      const cues = speakers.get(cue.speakerId) ?? []
      cues.push(cue)
      speakers.set(cue.speakerId, cues)
    }
    groupsByMedia[record.media.id] = {
      count: speakers.size,
      groups: [
        ...[...speakers].sort(([a], [b]) => a - b).map(([speakerId, cues]) => ({ speakerId, label: `说话人${speakerId + 1}`, cues })),
        ...(unknown.length ? [{ label: '未识别说话人', cues: unknown }] : [])
      ]
    }
  }
  return groupsByMedia
})
const previewResult = ref<MediaRecord | null>(null)
const operation = ref<'recognize' | 'clip'>('recognize')
const sourceProvider = ref<Provider>('aliyun')
const sourceLanguage = ref('auto')
const sourceRecord = computed(() => results.value.find(record => record.kind === 'source' && record.media.id === source.value?.id))
const video = ref<HTMLVideoElement>()
const current = ref(0)
const startText = ref('00:00:00.000')
const endText = ref('00:00:00.000')
const output = ref('')
const busy = ref(false)
const importing = ref(false)
const progress = ref(0)
const message = ref('导入一个视频，直接识别原文字幕或裁剪片段。')
const error = ref('')
const outputWarning = ref('')
const playbackError = ref('')
const active = computed(() => previewResult.value?.media ?? source.value)
const settingsOpen = ref(false)
const recognitionSettingsProvider = ref<Provider>('aliyun')
const translationSettingsProvider = ref<Provider>('aliyun')
const settingsSaving = ref(false)
const settingsError = ref('')
const settingsMessage = ref('')
const settingsStatus = ref<SettingsStatus>()
const exporting = ref(false)
const reviewingMediaId = ref('')
const reviewDrafts = reactive<Record<string, { start: string; end: string; error: string }>>({})
const settingsForm = reactive<SettingsUpdate>({
  aliyun: { apiKey: '', region: 'beijing', workspaceId: '', model: 'qwen3-asr-flash-filetrans', clear: false },
  volcengine: { apiKey: '', appId: '', accessToken: '', mode: 'apiKey', clear: false }
})
const languages = [ ['auto', '自动识别'], ['zh', '中文普通话'], ['en', '英语'], ['ja', '日语'], ['ko', '韩语'], ['yue', '粤语'], ['fr', '法语'], ['de', '德语'], ['es', '西班牙语'], ['pt', '葡萄牙语'], ['ru', '俄语'], ['it', '意大利语'], ['ar', '阿拉伯语'], ['id', '印尼语'], ['ms', '马来语'], ['th', '泰语'], ['vi', '越南语'], ['fil', '菲律宾语'], ['tr', '土耳其语'], ['uk', '乌克兰语'], ['pl', '波兰语'] ]
const recognizingIds = computed(() => new Set(results.value.filter(record => ['extracting', 'uploading', 'recognizing'].includes(record.job?.status ?? '')).map(record => record.media.id)))
const translationSettings = reactive<NonNullable<SettingsUpdate['translation']>>({
  aliyun: { apiKey: '', region: 'beijing', workspaceId: '', model: 'qwen-mt-plus', clear: false },
  volcengine: { apiKey: '', model: '', clear: false }
})
const translationOpen = ref(false)
const translationKind = ref<'recognized' | 'imported'>('imported')
const translationMediaId = ref('')
const translationSource = ref<TranslationSource>()
const translationSourceStale = ref(false)
const translationJob = ref<TranslationJob>()
const translationProvider = ref<Provider>('aliyun')
const targetLanguage = ref('zh')
const translationLoading = ref(false)
const translationStarting = ref(false)
const translationError = ref('')
const translationExportMessage = ref('')
const translationBusy = computed(() => translationStarting.value || translationJob.value?.status === 'running')
const translationCandidates = computed(() => results.value.filter(record => record.job?.result?.cues.length))
const translationTargets = languages.filter(language => ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt', 'it', 'ar', 'vi', 'th', 'id'].includes(language[0])).map(([code, label]) => [code, code === 'zh' ? '中文' : label])
const canRetryTranslation = computed(() => !translationSourceStale.value && !!translationJob.value && ['partial', 'cancelled'].includes(translationJob.value.status) && translationJob.value.source.id === translationSource.value?.id && translationJob.value.provider === translationProvider.value && translationJob.value.targetLanguage === targetLanguage.value && translationJob.value.model === settingsStatus.value?.translation[translationProvider.value].model)

function formatTime(seconds: number) {
  const ms = Math.round(Math.max(0, seconds) * 1000)
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}
function parseTime(text: string) {
  const value = text.trim()
  if (/^\d+(\.\d{1,3})?$/.test(value)) return Number(value)
  if (!/^\d{2,}:\d{2}:\d{2}(\.\d{1,3})?$/.test(value)) return NaN
  const [hours, minutes, seconds] = value.split(':').map(Number)
  return minutes < 60 && seconds < 60 ? hours * 3600 + minutes * 60 + seconds : NaN
}
const start = computed(() => parseTime(startText.value))
const end = computed(() => parseTime(endText.value))
const rangeError = computed(() => {
  if (!source.value) return ''
  if (![start.value, end.value].every(Number.isFinite)) return '请输入秒数或 HH:MM:SS.mmm 格式。'
  if (start.value < 0 || end.value > source.value.duration) return '裁剪范围不能超出视频时长。'
  if (start.value >= end.value) return '开始时间必须小于结束时间。'
  return ''
})
const unsubscribe = window.workbench?.onProgress(value => {
  if (Number.isFinite(value)) progress.value = Math.min(100, Math.max(0, value))
})
const unsubscribeJobs = window.workbench?.onSubtitleJob(job => {
  const record = results.value.find(record => record.media.id === job.mediaId)
  if (record) applySubtitleJob(record, job)
})
const unsubscribeTranslations = window.workbench?.onTranslationJob(job => {
  if (job.source.id === translationSource.value?.id) translationJob.value = job
})
onUnmounted(() => { unsubscribe?.(); unsubscribeJobs?.(); unsubscribeTranslations?.() })
onMounted(async () => {
  try {
    if (!window.workbench) throw new Error('请通过桌面应用使用识别服务设置。')
    const reply = await window.workbench.getSettings()
    if (!reply.ok) throw new Error(reply.error)
    settingsStatus.value = reply.value
    settingsForm.aliyun.region = reply.value.aliyun.region
    settingsForm.aliyun.workspaceId = reply.value.aliyun.workspaceId
    settingsForm.aliyun.model = reply.value.aliyun.model ?? 'qwen3-asr-flash-filetrans'
    settingsForm.volcengine.mode = reply.value.volcengine.mode
    settingsForm.volcengine.appId = reply.value.volcengine.appId
    translationSettings.aliyun.region = reply.value.translation.aliyun.region
    translationSettings.aliyun.workspaceId = reply.value.translation.aliyun.workspaceId
    translationSettings.aliyun.model = reply.value.translation.aliyun.model
    translationSettings.volcengine.model = reply.value.translation.volcengine.model
  } catch (reason) { settingsError.value = reason instanceof Error ? reason.message : '读取设置失败。' }
})

function toggleSettings() {
  settingsOpen.value = !settingsOpen.value
  if (!settingsOpen.value) {
    settingsForm.aliyun.apiKey = ''
    settingsForm.volcengine.apiKey = ''
    settingsForm.volcengine.accessToken = ''
    translationSettings.aliyun.apiKey = ''
    translationSettings.volcengine.apiKey = ''
  }
}
async function saveSettings() {
  settingsSaving.value = true
  settingsError.value = ''
  settingsMessage.value = ''
  try {
    const reply = await window.workbench.saveSettings(JSON.parse(JSON.stringify({ ...settingsForm, translation: translationSettings })) as SettingsUpdate)
    if (!reply.ok) throw new Error(reply.error)
    settingsStatus.value = reply.value
    settingsForm.aliyun.apiKey = ''
    settingsForm.volcengine.apiKey = ''
    settingsForm.volcengine.accessToken = ''
    settingsForm.aliyun.clear = false
    settingsForm.volcengine.clear = false
    translationSettings.aliyun.apiKey = ''
    translationSettings.volcengine.apiKey = ''
    translationSettings.aliyun.clear = false
    translationSettings.volcengine.clear = false
    settingsMessage.value = '配置已加密保存。这里只验证保存，实际权限和额度将在使用服务时检查。'
  } catch (reason) { settingsError.value = reason instanceof Error ? reason.message : '保存失败，请重试。' }
  finally { settingsSaving.value = false }
}
async function recognizeSource() {
  if (!source.value || importing.value) return
  let record = sourceRecord.value
  let pending: Promise<void> | undefined
  if (!record) {
    if (busy.value || !source.value.hasAudio || source.value.duration > 7200 || recognizingIds.value.size >= 2) return
    if (!settingsStatus.value?.[sourceProvider.value].configured) {
      settingsOpen.value = true
      recognitionSettingsProvider.value = sourceProvider.value
      settingsError.value = '请先填写并保存所选识别服务商的凭证，视频和识别选项已保留。'
      await nextTick()
      document.getElementById('settings-title')?.scrollIntoView({ block: 'start' })
      return
    }
    results.value.push({ kind: 'source', media: source.value, source: source.value, start: 0, end: source.value.duration, provider: sourceProvider.value, language: sourceLanguage.value, subtitlesOpen: false })
    record = results.value[results.value.length - 1]
    pending = recognize(record)
  }
  await nextTick()
  document.getElementById(`media-task-${record.media.id}`)?.scrollIntoView({ block: 'start' })
  await pending
}
function applySubtitleJob(record: MediaRecord, job: SubtitleJob) {
  if (record.job?.result?.recognitionId !== job.result?.recognitionId) record.speakersOpen = false
  record.job = job
  for (const item of job.review ?? []) {
    if (!item.status && !reviewDrafts[item.id]) reviewDrafts[item.id] = {
      start: item.start !== undefined && Number.isFinite(item.start) && item.start >= 0 ? formatTime(item.start) : '',
      end: item.end !== undefined && Number.isFinite(item.end) && item.end >= 0 ? formatTime(item.end) : '',
      error: ''
    }
  }
  if (job.status === 'succeeded' && job.result?.cues.length) record.subtitlesOpen = true
}
async function resolveReview(record: MediaRecord, item: SubtitleReview, action: 'accept' | 'discard') {
  if (reviewingMediaId.value || recognizingIds.value.has(record.media.id) || translationLoading.value || item.status) return
  const draft = reviewDrafts[item.id]
  if (!draft) return
  draft.error = ''
  let input: SubtitleReviewInput = { mediaId: record.media.id, reviewId: item.id, action: 'discard' }
  if (action === 'accept') {
    const start = parseTime(draft.start)
    const end = parseTime(draft.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) { draft.error = '请输入秒数或 HH:MM:SS.mmm 格式的有效时间。'; return }
    if (Math.round(end * 1000) <= Math.round(start * 1000)) { draft.error = '结束时间必须大于开始时间，最短为 1 毫秒。'; return }
    if (Math.round(end * 1000) > Math.round(record.media.duration * 1000)) { draft.error = '校对时间不能超出视频时长。'; return }
    input = { mediaId: record.media.id, reviewId: item.id, action: 'accept', start, end }
  }
  reviewingMediaId.value = record.media.id
  try {
    const reply = await window.workbench.resolveReview(input)
    if (!reply.ok) throw new Error(reply.error)
    applySubtitleJob(record, reply.value)
    if (action === 'accept') {
      record.exportMessage = ''
      if (translationKind.value === 'recognized' && translationMediaId.value === record.media.id && translationSource.value) translationSourceStale.value = true
    }
  } catch (reason) { draft.error = reason instanceof Error ? reason.message : '校对操作失败，请重试。' }
  finally { reviewingMediaId.value = '' }
}
async function recognize(record: MediaRecord) {
  if (recognizingIds.value.has(record.media.id) || reviewingMediaId.value === record.media.id || recognizingIds.value.size >= 2 || !record.media.hasAudio) return
  if (!settingsStatus.value?.[record.provider].configured) {
    settingsOpen.value = true
    recognitionSettingsProvider.value = record.provider
    settingsError.value = '请先填写并保存所选识别服务商的凭证。'
    await nextTick()
    document.getElementById('settings-title')?.scrollIntoView({ block: 'start' })
    return
  }
  const previousJob = record.job
  const previous = previousJob?.result
  const previousReview = previousJob?.review
  record.speakersOpen = false
  record.job = { mediaId: record.media.id, provider: record.provider, language: record.language, status: 'extracting', message: '正在准备识别任务…', result: previous, review: previousReview }
  record.exportMessage = ''
  try {
    const reply = await window.workbench.recognize({ id: record.media.id, provider: record.provider, language: record.language })
    if (!reply.ok) throw new Error(reply.error)
    applySubtitleJob(record, reply.value)
  } catch (reason) {
    record.job = { mediaId: record.media.id, provider: record.provider, language: record.language, model: previousJob?.model, recognitionId: previousJob?.recognitionId, status: 'failed', message: reason instanceof Error ? reason.message : '识别失败，请重试。', result: previous, review: previousReview }
  }
}
async function cancelRecognition(record: MediaRecord) {
  const reply = await window.workbench.cancelRecognition(record.media.id)
  if (!reply.ok && record.job) record.job.message = reply.error
}
async function exportSrt(record: MediaRecord, speakerId?: number | null) {
  const transcript = record.job?.result
  if (exporting.value || !transcript?.cues.length) return
  const label = speakerId === undefined ? '原文' : speakerId === null ? '未识别说话人' : `说话人${speakerId + 1}`
  exporting.value = true
  record.exportMessage = ''
  try {
    const reply = await window.workbench.exportSrt(speakerId === undefined ? record.media.id : { mediaId: record.media.id, speakerId, recognitionId: transcript.recognitionId })
    if (!reply.ok) throw new Error(reply.error)
    if (reply.value) record.exportMessage = `${label} SRT 已导出：${reply.value}`
  } catch (reason) { record.exportMessage = reason instanceof Error ? reason.message : '字幕导出失败。' }
  finally { exporting.value = false }
}

async function openTranslation(record?: MediaRecord) {
  translationOpen.value = true
  if (record && !translationBusy.value) {
    translationKind.value = 'recognized'
    translationMediaId.value = record.media.id
    await loadTranslationSource()
  }
  await nextTick()
  document.getElementById('translation-title')?.scrollIntoView({ block: 'start' })
}
async function loadTranslationSource() {
  if (translationBusy.value || translationLoading.value) return
  if (translationKind.value === 'recognized' && !translationMediaId.value) return
  translationLoading.value = true
  translationError.value = ''
  try {
    const reply = await window.workbench.loadTranslationSource(translationKind.value === 'recognized' ? { kind: 'recognized', mediaId: translationMediaId.value } : { kind: 'imported' })
    if (!reply.ok) throw new Error(reply.error)
    if (reply.value) {
      translationSource.value = reply.value
      translationSourceStale.value = false
      translationJob.value = undefined
      translationExportMessage.value = ''
    }
  } catch (reason) {
    translationError.value = reason instanceof Error ? reason.message : '字幕加载失败。'
    if (translationKind.value === 'recognized') { translationSource.value = undefined; translationJob.value = undefined }
  } finally { translationLoading.value = false }
}
async function startTranslation() {
  if (!translationSource.value || translationSourceStale.value || translationBusy.value || translationLoading.value) return
  if (!settingsStatus.value?.translation[translationProvider.value].configured) {
    settingsOpen.value = true
    translationSettingsProvider.value = translationProvider.value
    settingsError.value = '请先填写并保存翻译服务的凭证和模型，已选字幕会保留。'
    await nextTick()
    document.getElementById('translation-settings-title')?.scrollIntoView({ block: 'start' })
    return
  }
  translationStarting.value = true
  translationError.value = ''
  translationExportMessage.value = ''
  try {
    const reply = await window.workbench.translate({ sourceId: translationSource.value.id, provider: translationProvider.value, targetLanguage: targetLanguage.value, retryJobId: canRetryTranslation.value ? translationJob.value?.id : undefined })
    if (!reply.ok) throw new Error(reply.error)
    translationJob.value = reply.value
  } catch (reason) { translationError.value = reason instanceof Error ? reason.message : '翻译未完成，请重试。' }
  finally { translationStarting.value = false }
}
async function stopTranslation() {
  if (!translationJob.value) return
  const reply = await window.workbench.cancelTranslation(translationJob.value.id)
  if (!reply.ok) translationError.value = reply.error
}
async function exportTranslation(format: 'translated' | 'bilingual') {
  if (!translationJob.value || exporting.value) return
  exporting.value = true
  translationExportMessage.value = ''
  try {
    const reply = await window.workbench.exportTranslation({ jobId: translationJob.value.id, format })
    if (!reply.ok) throw new Error(reply.error)
    if (reply.value) translationExportMessage.value = `字幕已导出：${reply.value}`
  } catch (reason) { translationExportMessage.value = reason instanceof Error ? reason.message : '字幕导出失败。' }
  finally { exporting.value = false }
}

async function importVideo() {
  importing.value = true
  error.value = ''
  try {
    if (!window.workbench) throw new Error('请使用桌面应用启动此工具。')
    const reply = await window.workbench.importVideo()
    if (!reply.ok) throw new Error(reply.error)
    if (!reply.value) return
    source.value = reply.value
    operation.value = 'recognize'
    switchPreview(null)
    startText.value = formatTime(0)
    endText.value = formatTime(Math.floor(reply.value.duration * 1000) / 1000)
    output.value = ''
    outputWarning.value = ''
    progress.value = 0
    playbackError.value = ''
    message.value = '视频已导入。可直接识别整段视频，或切换到裁剪视频。'
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '导入失败。' }
  finally { importing.value = false }
}
async function chooseOutput() {
  if (!source.value) return
  error.value = ''
  try {
    const reply = await window.workbench.chooseOutput(source.value.id)
    if (!reply.ok) throw new Error(reply.error)
    if (reply.value) {
      output.value = reply.value
      outputWarning.value = ''
    }
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '选择输出位置失败。' }
}
async function clip() {
  if (!source.value || rangeError.value || !output.value || busy.value) return
  busy.value = true
  error.value = ''
  progress.value = 0
  outputWarning.value = ''
  const record = { source: source.value, start: start.value, end: end.value, output: output.value }
  switchPreview(null)
  message.value = '正在精确裁剪并重新编码，请稍候…'
  try {
    const reply = await window.workbench.clip({ id: record.source.id, start: record.start, end: record.end, output: record.output })
    if (!reply.ok) throw new Error(reply.error)
    results.value.push({ ...record, kind: 'clip', media: reply.value, provider: 'aliyun', language: 'auto', subtitlesOpen: false })
    output.value = reply.value.nextOutput
    outputWarning.value = reply.value.nextOutputWarning ?? ''
    message.value = `裁剪完成 · 实际时长 ${formatTime(reply.value.duration)}`
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '裁剪失败。'
    message.value = '裁剪未完成，请检查提示后重试。'
  } finally { busy.value = false }
}
async function reveal(record: MediaRecord) {
  const reply = await window.workbench.reveal(record.media.id)
  if (!reply.ok) error.value = reply.error
}
function switchPreview(record: MediaRecord | null) {
  video.value?.pause()
  previewResult.value = record
  current.value = 0
  playbackError.value = ''
}
</script>

<template>
  <main>
    <header>
      <div><span class="eyebrow">VIDEO SUBTITLE WORKBENCH</span><h1>视频字幕工作台<span class="badge">本地工具</span></h1></div>
      <div class="header-actions"><button @click="openTranslation()">字幕翻译</button><button :disabled="settingsSaving" @click="toggleSettings">{{ settingsOpen ? '收起设置' : '服务设置' }}</button><button class="primary" :disabled="busy || importing" @click="importVideo">{{ importing ? '正在读取…' : '＋ 导入本地视频' }}</button></div>
    </header>
    <section v-if="settingsOpen" class="settings" aria-labelledby="settings-title">
      <div class="section-title"><h2 id="settings-title">识别与翻译服务设置</h2><span>凭证仅在本机加密保存，留空保留已有密钥</span></div>
      <form @submit.prevent="saveSettings">
        <fieldset :disabled="settingsSaving" class="settings-grid">
          <section aria-labelledby="recognition-settings-title">
            <h3 id="recognition-settings-title">识别设置 <span class="muted">{{ settingsStatus?.[recognitionSettingsProvider].configured ? '已配置' : '未配置' }}</span></h3>
            <label for="recognition-settings-provider">识别服务商</label><select id="recognition-settings-provider" v-model="recognitionSettingsProvider"><option value="aliyun">阿里云百炼</option><option value="volcengine">火山引擎</option></select>
            <template v-if="recognitionSettingsProvider === 'aliyun'">
              <label for="ali-region">服务地域</label><select id="ali-region" v-model="settingsForm.aliyun.region"><option value="beijing">北京</option><option value="singapore">新加坡</option></select>
              <label for="ali-workspace">业务空间 ID（可选）</label><input id="ali-workspace" v-model="settingsForm.aliyun.workspaceId" autocomplete="off" placeholder="留空使用通用服务地址">
              <label for="ali-key">API Key</label><input id="ali-key" v-model="settingsForm.aliyun.apiKey" type="password" autocomplete="new-password" placeholder="输入新的百炼 API Key" :disabled="settingsForm.aliyun.clear">
              <label for="ali-model">识别模型 <span class="muted">带☆的模型支持说话人分离</span></label><select id="ali-model" v-model="settingsForm.aliyun.model" aria-describedby="ali-model-hint"><option value="qwen3-asr-flash-filetrans">qwen3-asr-flash-filetrans</option><option value="qwen-audio-3.1-asr-flash-filetrans">qwen-audio-3.1-asr-flash-filetrans ☆</option><option value="fun-asr">fun-asr ☆</option></select>
              <p id="ali-model-hint" class="muted hint">保存后生效。选择带☆的模型时将自动开启说话人分离。</p>
              <label class="check"><input v-model="settingsForm.aliyun.clear" type="checkbox">清除阿里云已保存凭证</label>
              <p class="muted hint">API Key 需与所选地域一致，并开通 {{ settingsForm.aliyun.model }}。当前个人验证版使用有效期 48 小时的临时音频存储。</p>
            </template>
            <template v-else>
              <label for="volc-mode">凭证类型</label><select id="volc-mode" v-model="settingsForm.volcengine.mode"><option value="apiKey">新版控制台 API Key</option><option value="legacy">旧版 App ID ＋ Access Token</option></select>
              <template v-if="settingsForm.volcengine.mode === 'apiKey'"><label for="volc-key">豆包语音 API Key</label><input id="volc-key" v-model="settingsForm.volcengine.apiKey" type="password" autocomplete="new-password" placeholder="不是火山方舟大模型 Key" :disabled="settingsForm.volcengine.clear"></template>
              <template v-else><label for="volc-app">App ID</label><input id="volc-app" v-model="settingsForm.volcengine.appId" autocomplete="off"><label for="volc-token">Access Token</label><input id="volc-token" v-model="settingsForm.volcengine.accessToken" type="password" autocomplete="new-password" placeholder="输入新的 Access Token" :disabled="settingsForm.volcengine.clear"></template>
              <label class="check"><input v-model="settingsForm.volcengine.clear" type="checkbox">清除火山引擎已保存凭证</label>
              <p class="muted hint">使用豆包录音文件识别极速版，需开通 volc.bigasr.auc_turbo。只上传视频中的音频，无需配置对象存储。</p>
            </template>
          </section>
          <section aria-labelledby="translation-settings-title">
            <h3 id="translation-settings-title">翻译服务设置 <span class="muted">{{ settingsStatus?.translation[translationSettingsProvider].configured ? '已配置' : '未配置' }}</span></h3>
            <label for="translation-settings-provider">翻译服务商</label><select id="translation-settings-provider" v-model="translationSettingsProvider"><option value="aliyun">阿里云 Qwen-MT</option><option value="volcengine">火山方舟</option></select>
            <template v-if="translationSettingsProvider === 'aliyun'">
              <label for="mt-ali-region">翻译地域</label><select id="mt-ali-region" v-model="translationSettings.aliyun.region"><option value="beijing">北京</option><option value="singapore">新加坡</option></select>
              <label for="mt-ali-workspace">翻译业务空间 ID（可选）</label><input id="mt-ali-workspace" v-model="translationSettings.aliyun.workspaceId" autocomplete="off">
              <label for="mt-ali-key">翻译 API Key</label><input id="mt-ali-key" v-model="translationSettings.aliyun.apiKey" type="password" autocomplete="new-password" :disabled="translationSettings.aliyun.clear" placeholder="需开通所选 Qwen-MT 模型">
              <label for="mt-ali-model">翻译模型</label><select id="mt-ali-model" v-model="translationSettings.aliyun.model"><option value="qwen-mt-plus">qwen-mt-plus</option><option value="qwen-mt-flash">qwen-mt-flash</option><option value="qwen-mt-lite">qwen-mt-lite</option><option value="qwen-mt-turbo">qwen-mt-turbo</option></select>
              <label class="check"><input v-model="translationSettings.aliyun.clear" type="checkbox">清除已保存的阿里云翻译凭证</label>
            </template>
            <template v-else>
              <label for="mt-volc-key">方舟 API Key</label><input id="mt-volc-key" v-model="translationSettings.volcengine.apiKey" type="password" autocomplete="new-password" :disabled="translationSettings.volcengine.clear" placeholder="不是豆包语音识别 Key">
              <label for="mt-volc-model">模型 ID 或推理接入点 ID</label><input id="mt-volc-model" v-model="translationSettings.volcengine.model" autocomplete="off" placeholder="填写控制台中已开通的模型 ID 或 ep-…">
              <label class="check"><input v-model="translationSettings.volcengine.clear" type="checkbox">清除已保存的火山方舟凭证</label>
              <p class="muted hint">使用北京地域方舟接口。请填写支持文字对话的模型，字幕逐条翻译，仅上传字幕文字。</p>
            </template>
          </section>
        </fieldset>
        <div class="settings-footer"><p v-if="settingsError" class="error" role="alert">{{ settingsError }}</p><p v-if="settingsMessage" class="muted" role="status">{{ settingsMessage }}</p><button class="primary" type="submit" :disabled="settingsSaving">{{ settingsSaving ? '正在保存…' : '保存服务配置' }}</button></div>
      </form>
    </section>
    <section v-if="translationOpen" class="translation settings" aria-labelledby="translation-title">
      <div class="section-title"><h2 id="translation-title">字幕翻译</h2><button class="small" @click="translationOpen = false">收起面板</button></div>
      <div class="translation-body">
        <fieldset :disabled="translationBusy || translationLoading" class="translation-inputs">
          <div class="source-options"><label class="check"><input v-model="translationKind" type="radio" value="recognized" :disabled="!translationCandidates.length" @change="translationSource = undefined; translationJob = undefined; translationError = ''">当前识别字幕</label><label class="check"><input v-model="translationKind" type="radio" value="imported" @change="translationSource = undefined; translationJob = undefined; translationError = ''">导入 SRT 文件</label></div>
          <label v-if="translationKind === 'recognized'" for="translation-clip">选择视频或片段<select id="translation-clip" v-model="translationMediaId" @change="loadTranslationSource"><option value="">请选择已有字幕的视频或片段</option><option v-for="record in translationCandidates" :key="record.media.id" :value="record.media.id">{{ record.kind === 'source' ? '完整视频' : '裁剪片段' }} · {{ record.media.name }}（{{ record.job?.result?.cues.length }} 条）</option></select></label>
          <button v-else class="small" @click="loadTranslationSource">{{ translationLoading ? '正在读取…' : '选择 SRT 文件…' }}</button>
          <button v-if="translationKind === 'recognized'" class="small" :disabled="!translationMediaId" @click="loadTranslationSource">加载当前字幕</button>
          <p v-if="!translationCandidates.length" class="muted hint">尚无当前识别字幕，也可直接导入 SRT 翻译，无需视频。</p>
          <div class="translation-selectors"><label for="translation-provider">翻译服务<select id="translation-provider" v-model="translationProvider"><option value="aliyun">阿里云百炼</option><option value="volcengine">火山方舟</option></select></label><label for="translation-target">目标语言<select id="translation-target" v-model="targetLanguage"><option v-for="language in translationTargets" :key="language[0]" :value="language[0]">{{ language[1] }}</option></select></label></div>
        </fieldset>
        <div v-if="translationSource" class="source-summary">
          <strong>{{ translationSource.name }}</strong><p class="muted">共 {{ translationSource.cues.length }} 条 · 时间范围 {{ formatTime(Math.min(...translationSource.cues.map(cue => cue.start))) }}—{{ formatTime(Math.max(...translationSource.cues.map(cue => cue.end))) }}</p>
          <details><summary>展开原文预览</summary><ol class="subtitle-list"><li v-for="(cue, index) in translationSource.cues" :key="index"><span>{{ index + 1 }} · {{ formatTime(cue.start) }} → {{ formatTime(cue.end) }}</span><p>{{ cue.text }}</p></li></ol></details>
        </div>
        <p class="muted hint">使用模型：{{ settingsStatus?.translation[translationProvider].model || '尚未配置' }}。仅上传字幕文字；保留时间轴与条目对应，不覆盖识别原稿或导入文件。按服务商计费，停止后的在途请求仍可能计费。</p>
        <p v-if="translationSource && translationSourceStale" class="warning" role="status">原文字幕已更新，此面板保留此前加载的内容。已有翻译仍使用原来的字幕；请点击“加载当前字幕”后开始新的翻译。</p>
        <div class="translation-actions"><button v-if="translationBusy" class="small" :disabled="!translationJob" @click="stopTranslation">停止翻译</button><button v-else class="primary" :disabled="!translationSource || translationSourceStale || translationLoading" @click="startTranslation">{{ canRetryTranslation ? '重试未完成部分' : translationJob ? '开始新翻译' : '开始翻译' }}</button></div>
        <p v-if="translationError" class="error" role="alert">{{ translationError }}</p>
        <template v-if="translationJob">
          <p class="job-message" :class="{ warning: translationJob.status === 'partial' || translationJob.status === 'cancelled' }" role="status">{{ translationJob.message }}</p>
          <progress :value="translationJob.completed" :max="translationJob.source.cues.length"/>
          <p class="muted hint">结果来源：{{ translationJob.source.name }} · 目标语言：{{ translationTargets.find(language => language[0] === translationJob?.targetLanguage)?.[1] }} · {{ translationJob.model }}</p>
          <div class="translation-actions"><button class="small" :disabled="translationJob.status !== 'completed' || exporting" @click="exportTranslation('translated')">导出译文 SRT</button><button class="small" :disabled="translationJob.status !== 'completed' || exporting" @click="exportTranslation('bilingual')">导出双语 SRT</button></div>
          <p v-if="translationExportMessage" class="export-message" role="status">{{ translationExportMessage }}</p>
          <div class="translation-table"><table><thead><tr><th>时间</th><th>原文</th><th>译文／状态</th></tr></thead><tbody><tr v-for="(cue, index) in translationJob.source.cues" :key="index"><td>{{ formatTime(cue.start) }}<br>{{ formatTime(cue.end) }}</td><td>{{ cue.text }}</td><td :class="{ error: translationJob.errors[index] }">{{ translationJob.translations[index] ?? (translationJob.errors[index] || '待翻译') }}</td></tr></tbody></table></div>
        </template>
      </div>
    </section>
    <div class="workspace">
      <section class="preview">
        <div class="section-title"><h2>视频预览</h2><span class="preview-label">{{ previewResult ? `${previewResult.kind === 'source' ? '完整视频' : '裁剪片段'} · ${previewResult.media.name}` : '源视频' }}</span></div>
        <div class="screen">
          <video v-if="active" :key="active.id" ref="video" :src="active.url" controls preload="metadata" @timeupdate="current = video?.currentTime ?? 0" @error="playbackError = '当前视频无法播放，可能是编码不受支持或文件已移动。可尝试裁剪为 MP4 后预览，或更换视频。'" />
          <div v-else class="empty"><span class="film">▷</span><h3>从一段视频开始</h3><p>导入本地视频，直接识别字幕或裁剪片段</p><span class="muted">MP4 · MOV · MKV · WebM 等</span></div>
        </div>
        <p v-if="playbackError" class="error" role="alert">{{ playbackError }}</p>
        <div class="metadata"><strong>{{ active?.name || '尚未导入视频' }}</strong><span v-if="active">{{ active.width }} × {{ active.height }} · {{ active.fps.toFixed(2) }} fps · {{ formatTime(active.duration) }}{{ active.hasAudio ? '' : ' · 无音轨' }}</span></div>
        <div class="preview-footer"><span>当前位置 <b>{{ formatTime(current) }}</b></span><button v-if="previewResult" class="small" @click="switchPreview(null)">返回当前源视频</button></div>
      </section>
      <aside>
        <div class="operation-tabs" role="group" aria-label="视频操作">
          <button :aria-pressed="operation === 'recognize'" aria-controls="source-recognition" @click="operation = 'recognize'">识别原文字幕</button>
          <button :aria-pressed="operation === 'clip'" aria-controls="clip-options" @click="operation = 'clip'">裁剪视频</button>
        </div>
        <section v-if="operation === 'recognize'" id="source-recognition" aria-labelledby="source-recognition-title">
          <div class="section-title"><h2 id="source-recognition-title">识别整段视频</h2><span>完整视频</span></div>
          <fieldset :disabled="!source || importing" class="source-recognition-options">
            <p class="recognition-source">{{ source?.name || '请先导入本地视频' }}</p>
            <div class="recognition-range"><span>识别范围：完整视频</span><strong>{{ source ? `00:00:00.000 → ${formatTime(source.duration)}` : '—' }}</strong></div>
            <p v-if="previewResult && previewResult.media.id !== source?.id" class="warning">当前正在预览历史任务；本次识别对象为上述源视频。</p>
            <template v-if="!sourceRecord">
              <label for="source-provider">识别服务商</label><select id="source-provider" v-model="sourceProvider" :disabled="busy"><option value="aliyun">阿里云百炼</option><option value="volcengine">火山引擎</option></select>
              <label for="source-language">音频语言</label><select id="source-language" v-model="sourceLanguage" :disabled="busy"><option v-for="language in languages" :key="language[0]" :value="language[0]">{{ language[1] }}</option></select>
              <p class="muted hint">仅上传此视频的音频，按所选服务商计费。单次最长 2 小时，提取的音频不超过 100MB。</p>
              <p v-if="source && !source.hasAudio" class="warning">此视频没有音轨，无法识别字幕。</p>
              <p v-else-if="source && source.duration > 7200" class="warning">视频超过 2 小时，请切换到“裁剪视频”缩短范围。</p>
              <p v-else-if="recognizingIds.size >= 2" class="muted hint">已有两个识别任务，请等待其中一个结束后再提交。</p>
            </template>
            <template v-else>
              <p class="muted hint">{{ sourceRecord.provider === 'aliyun' ? '阿里云百炼' : '火山引擎' }} · {{ languages.find(language => language[0] === sourceRecord?.language)?.[1] }}</p>
              <p v-if="sourceRecord.job" class="job-message" :class="{ error: sourceRecord.job.status === 'failed', warning: sourceRecord.job.status === 'cancelled' || (sourceRecord.job.status === 'succeeded' && sourceRecord.job.review?.some(item => !item.status)) }" role="status">{{ sourceRecord.job.message }}</p>
              <p class="muted hint">此视频已加入任务列表，可在任务中查看字幕、调整选项或重新识别。</p>
              <button v-if="recognizingIds.has(sourceRecord.media.id)" class="wide" @click="cancelRecognition(sourceRecord)">停止识别</button>
            </template>
            <button class="primary wide" :disabled="!sourceRecord && (busy || !source?.hasAudio || source.duration > 7200 || recognizingIds.size >= 2)" @click="recognizeSource">{{ sourceRecord ? '查看识别任务' : '开始识别整段视频' }}</button>
          </fieldset>
        </section>
        <section v-else id="clip-options" aria-labelledby="clip-options-title">
          <div class="section-title"><h2 id="clip-options-title">裁剪范围</h2><span>当前片段</span></div>
          <fieldset :disabled="!source || busy || importing">
            <label for="start">开始时间</label>
            <div class="time-row"><input id="start" v-model="startText" spellcheck="false" aria-describedby="time-help"><button class="small" :disabled="!!previewResult" @click="startText = formatTime(video?.currentTime ?? 0)">设为当前</button></div>
            <label for="end">结束时间</label>
            <div class="time-row"><input id="end" v-model="endText" spellcheck="false" aria-describedby="time-help"><button class="small" :disabled="!!previewResult" @click="endText = formatTime(Math.min(video?.currentTime ?? 0, source?.duration ?? 0))">设为当前</button></div>
            <p id="time-help" class="muted hint">支持 HH:MM:SS.mmm 或直接输入秒数。<br>“设为当前”使用源视频播放位置。</p>
            <p v-if="rangeError" class="error" role="alert">{{ rangeError }}</p>
            <div class="duration"><span>预计片段时长</span><strong>{{ source && !rangeError ? formatTime(end - start) : '—' }}</strong></div>
            <label>输出位置</label><button class="output" @click="chooseOutput">{{ output || '选择保存位置…' }}</button>
            <p class="muted hint">编号名称在成功后自动递增；自定义名称保持不变，再次裁剪前需另选文件名。</p>
            <p v-if="outputWarning" class="warning" role="status">{{ outputWarning }}</p>
            <p class="muted hint">输出为 MP4（H.264 / AAC），重新编码以精确截取；不会覆盖已有文件。边界精度受源视频帧率限制。</p>
            <button class="primary wide" :disabled="!!rangeError || !output" @click="clip">{{ busy ? '正在裁剪…' : '开始精确裁剪' }}</button>
          </fieldset>
        </section>
      </aside>
    </div>
    <section class="status" aria-live="polite"><div><span class="status-dot" :class="{ done: progress === 100 && !busy, failed: error }"></span><strong>{{ message }}</strong><span v-if="busy"> {{ progress.toFixed(0) }}%</span></div><progress v-if="busy" :value="progress" max="100"/><p v-if="error" class="error" role="alert">{{ error }}</p></section>
    <section v-if="results.length" class="history" aria-labelledby="results-title">
      <div class="section-title"><h2 id="results-title">视频与字幕任务 <span class="badge">{{ results.length }}</span></h2><span>按加入顺序 · 本次打开期间保留</span></div>
      <ol class="clip-list">
        <li v-for="(record, index) in results" :id="`media-task-${record.media.id}`" :key="record.media.id" class="clip-record" :class="{ selected: previewResult?.media.id === record.media.id }">
          <span class="clip-number">{{ index + 1 }}</span>
          <div class="clip-info">
            <strong><span class="task-kind">{{ record.kind === 'source' ? '完整视频' : '裁剪片段' }}</span>{{ record.media.name }}</strong>
            <span v-if="record.kind === 'clip'">源视频：{{ record.source.name }}</span>
            <span>{{ record.kind === 'source' ? '完整范围' : '裁剪范围' }} {{ formatTime(record.start) }} → {{ formatTime(record.end) }} · 时长 {{ formatTime(record.media.duration) }}</span>
            <span v-if="record.output" class="clip-path">{{ record.output }}</span>
          </div>
          <div class="result-actions">
            <span v-if="previewResult?.media.id === record.media.id" class="previewing">正在预览</span>
            <button class="small" :disabled="importing" @click="switchPreview(record)">预览</button>
            <button class="small" @click="reveal(record)">打开所在文件夹</button>
          </div>
          <div class="recognition-panel">
            <div class="recognition-controls">
              <label>识别服务商<select v-model="record.provider" :disabled="recognizingIds.has(record.media.id)" :aria-label="`任务${index + 1}识别服务商`"><option value="aliyun">阿里云百炼</option><option value="volcengine">火山引擎</option></select></label>
              <label>音频语言<select v-model="record.language" :disabled="recognizingIds.has(record.media.id)" :aria-label="`任务${index + 1}音频语言`"><option v-for="language in languages" :key="language[0]" :value="language[0]">{{ language[1] }}</option></select></label>
              <button v-if="recognizingIds.has(record.media.id)" class="small" @click="cancelRecognition(record)">停止识别</button>
              <button v-else class="small" :disabled="!record.media.hasAudio || recognizingIds.size >= 2 || reviewingMediaId === record.media.id" @click="recognize(record)">{{ record.job?.result?.cues.length ? '重新识别原文' : record.job?.status === 'failed' || record.job?.status === 'cancelled' ? '重试识别' : '生成原文字幕' }}</button>
              <button v-if="record.job?.result?.cues.length" class="small" @click="record.subtitlesOpen = !record.subtitlesOpen">{{ record.subtitlesOpen ? '收起字幕' : `查看字幕（${record.job.result.cues.length}）` }}</button>
              <button v-if="record.job?.result?.cues.length && record.job.result.provider === 'aliyun' && ['qwen-audio-3.1-asr-flash-filetrans', 'fun-asr'].includes(record.job.result.model ?? '')" class="small" :disabled="recognizingIds.has(record.media.id) || reviewingMediaId === record.media.id" :aria-expanded="!!record.speakersOpen" :aria-controls="`speaker-groups-${record.media.id}`" @click="record.speakersOpen = !record.speakersOpen">{{ record.speakersOpen ? '收起说话人分组' : '根据说话人拆分 SRT' }}</button>
              <button v-if="record.job?.result?.cues.length" class="small" :disabled="exporting" @click="exportSrt(record)">导出原文 SRT</button>
              <button v-if="record.job?.result?.cues.length" class="small" :disabled="translationBusy || translationLoading" @click="openTranslation(record)">翻译字幕</button>
            </div>
            <p class="muted hint">{{ record.media.hasAudio ? '生成字幕仅上传此视频的音频，按所选服务商计费；已提交任务的停止或重试可能仍产生费用。' : '此视频没有音轨，无法生成字幕。' }}</p>
            <p v-if="record.job" class="job-message" :class="{ error: record.job.status === 'failed', warning: record.job.status === 'cancelled' || (record.job.status === 'succeeded' && record.job.review?.some(item => !item.status)) }" role="status">{{ record.job.message }}</p>
            <p v-if="record.exportMessage && !record.speakersOpen" class="export-message" role="status">{{ record.exportMessage }}</p>
            <div v-if="record.job?.review?.length" class="subtitle-review">
              <p v-if="record.job.review.some(item => !item.status)" class="warning">待校对 {{ record.job.review.filter(item => !item.status).length }} 条：修改时间后确认加入字幕，或选择废弃。未确认的条目不参与导出和翻译。</p>
              <p v-else class="muted">本次待校对内容均已处理。</p>
              <p v-if="record.job.review.some(item => !item.status) && record.job.result && record.job.recognitionId && record.job.result.recognitionId !== record.job.recognitionId" class="warning">当前保留的是此前识别结果。确认加入本次待校对字幕后，将切换为本次识别结果，避免混入不同任务的说话人。</p>
              <ol class="subtitle-list review-pending">
                <li v-for="item in record.job.review.filter(item => !item.status)" :key="item.id">
                  <span>原文第 {{ item.sourceIndex }} 条 · {{ item.start !== undefined && item.start >= 0 ? formatTime(item.start) : '未知起点' }} → {{ item.end !== undefined && item.end >= 0 ? formatTime(item.end) : '未知终点' }}<template v-if="record.job.model && ['qwen-audio-3.1-asr-flash-filetrans', 'fun-asr'].includes(record.job.model)"> · {{ item.speakerId !== undefined ? `说话人${item.speakerId + 1}` : '未识别说话人' }}</template></span>
                  <p>{{ item.text || '（无可用文字）' }}</p>
                  <p class="warning">{{ item.reason }}</p>
                  <fieldset v-if="reviewDrafts[item.id]" class="review-editor" :disabled="!!reviewingMediaId || recognizingIds.has(record.media.id) || translationLoading">
                    <div><label :for="`review-start-${item.id}`">开始时间</label><input :id="`review-start-${item.id}`" v-model="reviewDrafts[item.id].start" spellcheck="false" :aria-describedby="`review-help-${item.id}`" @input="reviewDrafts[item.id].error = ''"></div>
                    <div><label :for="`review-end-${item.id}`">结束时间</label><input :id="`review-end-${item.id}`" v-model="reviewDrafts[item.id].end" spellcheck="false" :aria-describedby="`review-help-${item.id}`" @input="reviewDrafts[item.id].error = ''"></div>
                    <p :id="`review-help-${item.id}`" class="muted hint">支持 HH:MM:SS.mmm 或秒数，{{ record.kind === 'source' ? '以源视频开头为基准' : '以此片段开头为基准' }}。结束时间须晚于开始时间，且不超过 {{ formatTime(record.media.duration) }}。</p>
                    <div class="review-actions"><button class="primary small" :disabled="!item.text.trim()" @click="resolveReview(record, item, 'accept')">确认加入字幕</button><button class="small discard" @click="resolveReview(record, item, 'discard')">废弃</button></div>
                  </fieldset>
                  <p v-if="reviewDrafts[item.id]?.error" class="error" role="alert">{{ reviewDrafts[item.id].error }}</p>
                </li>
              </ol>
              <details v-if="record.job.review.some(item => !!item.status)" class="review-history">
                <summary>已处理 {{ record.job.review.filter(item => !!item.status).length }} 条</summary>
                <ol class="subtitle-list">
                  <li v-for="item in record.job.review.filter(item => !!item.status)" :key="item.id">
                    <span>原文第 {{ item.sourceIndex }} 条 · {{ item.status === 'accepted' ? '已加入字幕' : '已废弃' }}<template v-if="item.corrected"> · {{ formatTime(item.corrected.start) }} → {{ formatTime(item.corrected.end) }}</template></span>
                    <p>{{ item.text || '（无可用文字）' }}</p>
                  </li>
                </ol>
              </details>
            </div>
            <div v-if="record.subtitlesOpen && record.job?.result?.cues.length" class="subtitles">
              <p class="muted">原文字幕 · {{ record.job.result.provider === 'aliyun' ? '阿里云百炼' : '火山引擎' }} · {{ record.kind === 'source' ? '时间以源视频开头为基准' : '时间以此片段开头为基准' }}</p>
              <ol class="subtitle-list"><li v-for="(cue, cueIndex) in record.job.result.cues" :key="cueIndex"><span>{{ cueIndex + 1 }} · {{ formatTime(cue.start) }} → {{ formatTime(cue.end) }}</span><p>{{ cue.text }}</p></li></ol>
            </div>
            <section v-if="record.speakersOpen && record.job?.result?.cues.length && record.job.result.provider === 'aliyun' && ['qwen-audio-3.1-asr-flash-filetrans', 'fun-asr'].includes(record.job.result.model ?? '')" :id="`speaker-groups-${record.media.id}`" class="speaker-groups" :aria-labelledby="`speaker-groups-title-${record.media.id}`">
              <h3 :id="`speaker-groups-title-${record.media.id}`">按说话人拆分</h3>
              <p v-if="speakerGroups[record.media.id].count" class="muted" role="status">识别到 {{ speakerGroups[record.media.id].count }} 个说话人，已分为 {{ speakerGroups[record.media.id].count }} 组字幕。<template v-if="speakerGroups[record.media.id].groups.some(group => group.speakerId === undefined)">未识别说话人的字幕已单独保留。</template></p>
              <p v-else class="warning" role="status">识别结果未返回有效的说话人信息，暂无法按说话人拆分。现有字幕已保留。</p>
              <p class="muted hint">使用本次已有识别结果，保留原时间轴，各组可分别导出 SRT。待校对字幕确认加入后参与分组。</p>
              <p v-if="record.exportMessage" class="export-message" role="status">{{ record.exportMessage }}</p>
              <div v-for="group in speakerGroups[record.media.id].groups" :key="group.speakerId ?? 'unknown'" class="speaker-group">
                <details>
                  <summary>{{ group.label }} · {{ group.cues.length }} 条字幕</summary>
                  <ol class="subtitle-list"><li v-for="(cue, cueIndex) in group.cues" :key="cueIndex"><span>{{ cueIndex + 1 }} · {{ formatTime(cue.start) }} → {{ formatTime(cue.end) }}</span><p>{{ cue.text }}</p></li></ol>
                </details>
                <button class="small" :disabled="exporting || recognizingIds.has(record.media.id) || reviewingMediaId === record.media.id" :aria-label="`导出${group.label} SRT`" @click="exportSrt(record, group.speakerId ?? null)">导出 SRT</button>
              </div>
            </section>
          </div>
        </li>
      </ol>
    </section>
    <footer>本地裁剪 · 识别仅上传音频 · 翻译仅上传字幕文字<span>识别与 SRT 翻译</span></footer>
  </main>
</template>

<style>
:root{font-family:Segoe UI,Microsoft YaHei,sans-serif;color:#e5ebf5;background:#10151f;font-synthesis:none;color-scheme:dark}*{box-sizing:border-box}body{margin:0}button,input{font:inherit}button{border:1px solid #354257;background:#242f40;color:#e5ebf5;border-radius:8px;padding:11px 16px;cursor:pointer}button:hover:not(:disabled){background:#33435c}button:disabled{opacity:.4;cursor:not-allowed}main{max-width:1440px;margin:auto;padding:32px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:30px}.eyebrow{font-size:11px;letter-spacing:2px;color:#8c9bb0}h1{font-size:25px;letter-spacing:1px;margin:9px 0}h2{font-size:15px;margin:0}.badge{vertical-align:middle;font-size:11px;letter-spacing:0;color:#91b6ff;background:#233454;border-radius:5px;padding:5px 8px;margin-left:14px}.primary{background:#608dff;border-color:#608dff;color:#07142e;font-weight:650}.primary:hover:not(:disabled){background:#88aaff}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:22px}.preview,aside,.status{border:1px solid #2b3546;background:#19212e;border-radius:12px}.preview{overflow:hidden;align-self:start}.section-title{display:flex;justify-content:space-between;align-items:center;padding:19px 22px}.section-title>span,.muted{color:#8c9bb0;font-size:12px}.screen{background:#080b10;aspect-ratio:16/9;display:flex;align-items:center;justify-content:center}video{width:100%;height:100%;max-height:62vh}.empty{text-align:center;color:#b7c3d5}.film{font-size:48px;color:#6c8dbe}.empty h3{font-size:18px;margin:14px 0}.empty p{font-size:13px}.metadata{padding:19px 22px;display:flex;flex-direction:column;gap:7px;overflow-wrap:anywhere}.metadata strong{font-size:14px}.metadata span{color:#8c9bb0;font-size:12px}.preview-footer{padding:13px 22px;border-top:1px solid #2b3546;display:flex;align-items:center;justify-content:space-between;font-size:12px;color:#9baac0}.preview-footer b{margin-left:10px;color:#dde7f6;font-variant-numeric:tabular-nums}fieldset{border:0;padding:0 22px 23px;margin:0;min-width:0}label{display:block;font-size:13px;color:#bac7da;margin:18px 0 9px}.time-row{display:flex;gap:8px}input{width:0;flex:1;background:#111925;color:#e5ebf5;border:1px solid #3a4961;border-radius:7px;padding:11px;font-variant-numeric:tabular-nums;min-width:0}input:focus{outline:2px solid #608dff}.small{font-size:12px;padding:8px 11px;white-space:nowrap}.hint{line-height:1.8;margin:12px 0}.duration{display:flex;justify-content:space-between;background:#111925;border-radius:8px;padding:17px 12px;margin:20px 0;font-size:12px;color:#aebbd0}.duration strong{color:#99b8ff;font-variant-numeric:tabular-nums}.output{width:100%;text-align:left;font-size:12px;overflow-wrap:anywhere}.wide{width:100%;margin-top:10px}.status{margin-top:22px;padding:19px 22px;font-size:13px}.status-dot{display:inline-block;width:8px;height:8px;background:#719bed;border-radius:50%;margin-right:10px}.done{background:#75d5a2}.failed{background:#ff8e8e}.error{color:#ffabab;font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}.preview>.error{margin:14px 22px}progress{width:100%;height:8px;margin-top:16px;accent-color:#608dff}.result-actions{display:flex;gap:10px;margin-top:16px}.result-actions button{font-size:12px}footer{display:flex;justify-content:space-between;color:#65768e;font-size:11px;margin-top:22px}@media(max-width:950px){main{padding:20px}.workspace{grid-template-columns:minmax(0,1fr) 310px}.section-title{padding:16px}fieldset{padding:0 16px 20px}}
.preview-label{max-width:70%;text-align:right;overflow-wrap:anywhere}.warning{color:#edc482;font-size:12px;line-height:1.7}.history{margin-top:22px;border:1px solid #2b3546;background:#19212e;border-radius:12px;overflow:hidden}.clip-list{margin:0;padding:0;list-style:none}.clip-record{display:flex;align-items:center;gap:16px;padding:20px 22px;border-top:1px solid #2b3546}.clip-record.selected{background:#20304a}.clip-number{align-self:flex-start;color:#8c9bb0;font-size:13px;min-width:18px;padding-top:2px;font-variant-numeric:tabular-nums}.clip-info{display:flex;flex:1;min-width:0;flex-direction:column;gap:7px;overflow-wrap:anywhere}.clip-info strong{font-size:14px}.clip-info>span{font-size:12px;color:#aab8cd}.clip-info>.clip-path{font-size:11px;color:#8194b0}.clip-record .result-actions{margin:0;flex-wrap:wrap;justify-content:flex-end;align-items:center;max-width:270px}.previewing{font-size:11px;color:#99b8ff}@media(max-width:950px){.clip-record{flex-wrap:wrap}.clip-record .result-actions{margin-left:34px;max-width:none;width:100%;justify-content:flex-start}}
.header-actions{display:flex;gap:10px;align-items:center}.settings{border:1px solid #2b3546;background:#19212e;border-radius:12px;margin-bottom:24px}.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:32px;align-items:start}.settings-grid>section{min-width:0}.settings-grid h3{font-size:15px}.settings-grid input:not([type=checkbox]){display:block;width:100%}.settings-grid select{width:100%}.settings-footer{padding:0 22px 22px}.settings-footer button{margin-top:8px}.check{display:flex;align-items:center;gap:8px;font-size:12px}.check input{width:16px;height:16px;flex:none}select{font:inherit;background:#111925;color:#e5ebf5;border:1px solid #3a4961;border-radius:7px;padding:10px;max-width:100%}select:focus{outline:2px solid #608dff}select:disabled{opacity:.5}.clip-record{flex-wrap:wrap}.recognition-panel{flex-basis:100%;min-width:0;margin-left:34px;padding-top:12px;border-top:1px dashed #354257}.recognition-controls{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}.recognition-controls label{font-size:11px;margin:0}.recognition-controls select{display:block;margin-top:7px;min-width:130px;font-size:12px}.recognition-controls button{min-height:37px}.job-message,.export-message{font-size:12px;line-height:1.8;overflow-wrap:anywhere}.export-message{color:#9ac5f5}.subtitles{margin-top:14px;padding:12px 16px;background:#111925;border-radius:8px}.subtitle-list{list-style:none;padding:0;margin:0;max-height:360px;overflow:auto}.subtitle-list li{border-top:1px solid #2b3546;padding:12px 0}.subtitle-list span{font-size:11px;color:#8fa4c4;font-variant-numeric:tabular-nums}.subtitle-list p{font-size:13px;line-height:1.7;white-space:pre-wrap;margin:7px 0 0}@media(max-width:950px){.settings-grid{gap:20px}.header-actions button{font-size:12px;padding:10px}.recognition-panel{margin-left:0}}@media(max-width:700px){.settings-grid{grid-template-columns:minmax(0,1fr)}}
.translation-body{padding:0 22px 22px}.translation-inputs{padding:0;min-width:0}.source-options,.translation-selectors,.translation-actions{display:flex;gap:16px;flex-wrap:wrap;align-items:center}.translation-selectors label{min-width:180px}.translation-inputs select{display:block;margin-top:8px;width:100%}.translation-actions{margin-top:14px}.source-summary{background:#111925;border-radius:8px;padding:16px;margin-top:18px;font-size:13px;overflow-wrap:anywhere}.source-summary summary{cursor:pointer;color:#99b8ff;font-size:12px}.source-summary .subtitle-list{margin-top:12px;max-height:220px}.translation-table{max-height:420px;overflow:auto;margin-top:18px;border:1px solid #354257;border-radius:8px}.translation-table table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}.translation-table th,.translation-table td{padding:12px;text-align:left;vertical-align:top;border-bottom:1px solid #354257;overflow-wrap:anywhere;white-space:pre-wrap;line-height:1.7}.translation-table th{background:#111925;position:sticky;top:0}.translation-table th:first-child{width:145px}.translation-table td:first-child{font-size:11px;color:#8fa4c4}.source-options input{flex:none}.translation .check{margin-top:6px}
.operation-tabs{display:flex;gap:6px;padding:16px 16px 0}.operation-tabs button{flex:1;padding:10px 6px;font-size:12px}.operation-tabs button[aria-pressed=true]{background:#293e64;border-color:#608dff;color:#dbe7ff}.source-recognition-options select{display:block;width:100%}.recognition-source{font-size:13px;line-height:1.7;overflow-wrap:anywhere;margin:0 0 16px}.recognition-range{display:flex;flex-direction:column;gap:10px;padding:14px 12px;border-radius:8px;background:#111925;font-size:12px;color:#aebbd0}.recognition-range strong{font-size:11px;color:#99b8ff;font-variant-numeric:tabular-nums}.task-kind{display:inline-block;margin-right:9px;padding:3px 7px;border:1px solid #41567a;border-radius:5px;font-size:11px;font-weight:400;color:#a7c6ff;vertical-align:middle}.clip-record{scroll-margin-top:20px}
.subtitle-review{margin-top:14px;padding:12px 16px;border:1px solid #6a5838;border-radius:8px;background:#211e19}.subtitle-review>.warning{margin-top:0}.subtitle-review .subtitle-list .warning{font-size:12px}
.review-editor{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:0;margin:12px 0 0}.review-editor label{margin:0 0 7px;font-size:12px}.review-editor input{display:block;width:100%;font-size:12px}.review-editor>.hint,.review-actions{grid-column:1/-1}.review-editor>.hint{margin:0}.review-actions{display:flex;gap:10px;flex-wrap:wrap}.discard{color:#ffb0a5}.review-history{margin-top:12px}.review-history summary{font-size:12px;color:#aebbd0;cursor:pointer}
.speaker-groups{margin-top:14px;padding:16px;background:#111925;border:1px solid #354257;border-radius:8px;overflow-wrap:anywhere}.speaker-groups h3{font-size:14px;margin:0 0 12px}.speaker-group{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:12px;margin-top:10px;padding:12px;border:1px solid #2b3546;border-radius:7px}.speaker-group details{min-width:0}.speaker-group summary{font-size:13px;line-height:34px;color:#a7c6ff;cursor:pointer}.speaker-group .subtitle-list{margin-top:10px;max-height:240px}
</style>
