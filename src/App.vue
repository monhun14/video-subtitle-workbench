<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import type { MediaInfo, Provider, SettingsStatus, SettingsUpdate, SubtitleJob } from './env'

const source = ref<MediaInfo | null>(null)
interface ClipRecord { media: MediaInfo; source: MediaInfo; start: number; end: number; output: string; provider: Provider; language: string; job?: SubtitleJob; subtitlesOpen: boolean; exportMessage?: string }
const results = ref<ClipRecord[]>([])
const previewResult = ref<ClipRecord | null>(null)
const video = ref<HTMLVideoElement>()
const current = ref(0)
const startText = ref('00:00:00.000')
const endText = ref('00:00:00.000')
const output = ref('')
const busy = ref(false)
const importing = ref(false)
const progress = ref(0)
const message = ref('导入一个视频，开始制作你的第一个片段。')
const error = ref('')
const outputWarning = ref('')
const playbackError = ref('')
const active = computed(() => previewResult.value?.media ?? source.value)
const settingsOpen = ref(false)
const settingsSaving = ref(false)
const settingsError = ref('')
const settingsMessage = ref('')
const settingsStatus = ref<SettingsStatus>()
const exporting = ref(false)
const settingsForm = reactive<SettingsUpdate>({
  aliyun: { apiKey: '', region: 'beijing', workspaceId: '', clear: false },
  volcengine: { apiKey: '', appId: '', accessToken: '', mode: 'apiKey', clear: false }
})
const languages = [ ['auto', '自动识别'], ['zh', '中文普通话'], ['en', '英语'], ['ja', '日语'], ['ko', '韩语'], ['yue', '粤语'], ['fr', '法语'], ['de', '德语'], ['es', '西班牙语'], ['pt', '葡萄牙语'], ['ru', '俄语'], ['it', '意大利语'], ['ar', '阿拉伯语'], ['id', '印尼语'], ['ms', '马来语'], ['th', '泰语'], ['vi', '越南语'], ['fil', '菲律宾语'], ['tr', '土耳其语'], ['uk', '乌克兰语'], ['pl', '波兰语'] ]
const recognizingIds = computed(() => new Set(results.value.filter(record => ['extracting', 'uploading', 'recognizing'].includes(record.job?.status ?? '')).map(record => record.media.id)))

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
  if (record) record.job = job
})
onUnmounted(() => { unsubscribe?.(); unsubscribeJobs?.() })
onMounted(async () => {
  try {
    if (!window.workbench) throw new Error('请通过桌面应用使用识别服务设置。')
    const reply = await window.workbench.getSettings()
    if (!reply.ok) throw new Error(reply.error)
    settingsStatus.value = reply.value
    settingsForm.aliyun.region = reply.value.aliyun.region
    settingsForm.aliyun.workspaceId = reply.value.aliyun.workspaceId
    settingsForm.volcengine.mode = reply.value.volcengine.mode
    settingsForm.volcengine.appId = reply.value.volcengine.appId
  } catch (reason) { settingsError.value = reason instanceof Error ? reason.message : '读取设置失败。' }
})

function toggleSettings() {
  settingsOpen.value = !settingsOpen.value
  if (!settingsOpen.value) {
    settingsForm.aliyun.apiKey = ''
    settingsForm.volcengine.apiKey = ''
    settingsForm.volcengine.accessToken = ''
  }
}
async function saveSettings() {
  settingsSaving.value = true
  settingsError.value = ''
  settingsMessage.value = ''
  try {
    const reply = await window.workbench.saveSettings(JSON.parse(JSON.stringify(settingsForm)) as SettingsUpdate)
    if (!reply.ok) throw new Error(reply.error)
    settingsStatus.value = reply.value
    settingsForm.aliyun.apiKey = ''
    settingsForm.volcengine.apiKey = ''
    settingsForm.volcengine.accessToken = ''
    settingsForm.aliyun.clear = false
    settingsForm.volcengine.clear = false
    settingsMessage.value = '配置已加密保存。这里只验证保存，实际权限和额度将在识别时检查。'
  } catch (reason) { settingsError.value = reason instanceof Error ? reason.message : '保存失败，请重试。' }
  finally { settingsSaving.value = false }
}
async function recognize(record: ClipRecord) {
  if (recognizingIds.value.has(record.media.id)) return
  if (!settingsStatus.value?.[record.provider].configured) {
    settingsOpen.value = true
    settingsError.value = '请先填写并保存所选识别服务商的凭证。'
    return
  }
  const previous = record.job?.result
  record.job = { mediaId: record.media.id, provider: record.provider, language: record.language, status: 'extracting', message: '正在准备识别任务…', result: previous }
  record.exportMessage = ''
  try {
    const reply = await window.workbench.recognize({ id: record.media.id, provider: record.provider, language: record.language })
    if (!reply.ok) throw new Error(reply.error)
    record.job = reply.value
    if (reply.value.status === 'succeeded' && reply.value.result?.cues.length) record.subtitlesOpen = true
  } catch (reason) {
    record.job = { mediaId: record.media.id, provider: record.provider, language: record.language, status: 'failed', message: reason instanceof Error ? reason.message : '识别失败，请重试。', result: previous }
  }
}
async function cancelRecognition(record: ClipRecord) {
  const reply = await window.workbench.cancelRecognition(record.media.id)
  if (!reply.ok && record.job) record.job.message = reply.error
}
async function exportSrt(record: ClipRecord) {
  exporting.value = true
  record.exportMessage = ''
  try {
    const reply = await window.workbench.exportSrt(record.media.id)
    if (!reply.ok) throw new Error(reply.error)
    if (reply.value) record.exportMessage = `原文 SRT 已导出：${reply.value}`
  } catch (reason) { record.exportMessage = reason instanceof Error ? reason.message : '字幕导出失败。' }
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
    switchPreview(null)
    startText.value = formatTime(0)
    endText.value = formatTime(Math.floor(reply.value.duration * 1000) / 1000)
    output.value = ''
    outputWarning.value = ''
    progress.value = 0
    playbackError.value = ''
    message.value = '视频已导入。设置范围后选择输出位置。'
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
    results.value.push({ ...record, media: reply.value, provider: 'aliyun', language: 'auto', subtitlesOpen: false })
    output.value = reply.value.nextOutput
    outputWarning.value = reply.value.nextOutputWarning ?? ''
    message.value = `裁剪完成 · 实际时长 ${formatTime(reply.value.duration)}`
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '裁剪失败。'
    message.value = '裁剪未完成，请检查提示后重试。'
  } finally { busy.value = false }
}
async function reveal(record: ClipRecord) {
  const reply = await window.workbench.reveal(record.media.id)
  if (!reply.ok) error.value = reply.error
}
function switchPreview(record: ClipRecord | null) {
  video.value?.pause()
  previewResult.value = record
  current.value = 0
  playbackError.value = ''
}
</script>

<template>
  <main>
    <header>
      <div><span class="eyebrow">VIDEO SUBTITLE WORKBENCH</span><h1>视频裁剪工作台<span class="badge">本地工具</span></h1></div>
      <div class="header-actions"><button :disabled="settingsSaving" @click="toggleSettings">{{ settingsOpen ? '收起设置' : '识别服务设置' }}</button><button class="primary" :disabled="busy || importing" @click="importVideo">{{ importing ? '正在读取…' : '＋ 导入本地视频' }}</button></div>
    </header>
    <section v-if="settingsOpen" class="settings" aria-labelledby="settings-title">
      <div class="section-title"><h2 id="settings-title">识别服务设置</h2><span>凭证仅在本机加密保存，留空保留已有密钥</span></div>
      <form @submit.prevent="saveSettings">
        <fieldset :disabled="settingsSaving" class="settings-grid">
          <div>
            <h3>阿里云百炼 <span class="muted">{{ settingsStatus?.aliyun.configured ? '已配置' : '未配置' }}</span></h3>
            <label for="ali-region">服务地域</label><select id="ali-region" v-model="settingsForm.aliyun.region"><option value="beijing">北京</option><option value="singapore">新加坡</option></select>
            <label for="ali-workspace">业务空间 ID（可选）</label><input id="ali-workspace" v-model="settingsForm.aliyun.workspaceId" autocomplete="off" placeholder="留空使用通用服务地址">
            <label for="ali-key">API Key</label><input id="ali-key" v-model="settingsForm.aliyun.apiKey" type="password" autocomplete="new-password" placeholder="输入新的百炼 API Key" :disabled="settingsForm.aliyun.clear">
            <label class="check"><input v-model="settingsForm.aliyun.clear" type="checkbox">清除阿里云已保存凭证</label>
            <p class="muted hint">使用 Qwen3 文件转写模型。API Key 需与所选地域一致，并开通 qwen3-asr-flash-filetrans。当前个人验证版使用有效期 48 小时的临时音频存储。</p>
          </div>
          <div>
            <h3>火山引擎 <span class="muted">{{ settingsStatus?.volcengine.configured ? '已配置' : '未配置' }}</span></h3>
            <label for="volc-mode">凭证类型</label><select id="volc-mode" v-model="settingsForm.volcengine.mode"><option value="apiKey">新版控制台 API Key</option><option value="legacy">旧版 App ID ＋ Access Token</option></select>
            <template v-if="settingsForm.volcengine.mode === 'apiKey'"><label for="volc-key">豆包语音 API Key</label><input id="volc-key" v-model="settingsForm.volcengine.apiKey" type="password" autocomplete="new-password" placeholder="不是火山方舟大模型 Key" :disabled="settingsForm.volcengine.clear"></template>
            <template v-else><label for="volc-app">App ID</label><input id="volc-app" v-model="settingsForm.volcengine.appId" autocomplete="off"><label for="volc-token">Access Token</label><input id="volc-token" v-model="settingsForm.volcengine.accessToken" type="password" autocomplete="new-password" placeholder="输入新的 Access Token" :disabled="settingsForm.volcengine.clear"></template>
            <label class="check"><input v-model="settingsForm.volcengine.clear" type="checkbox">清除火山引擎已保存凭证</label>
            <p class="muted hint">使用豆包录音文件识别极速版，需开通 volc.bigasr.auc_turbo。只上传片段音频，无需配置对象存储。</p>
          </div>
        </fieldset>
        <div class="settings-footer"><p v-if="settingsError" class="error" role="alert">{{ settingsError }}</p><p v-if="settingsMessage" class="muted" role="status">{{ settingsMessage }}</p><button class="primary" type="submit" :disabled="settingsSaving">{{ settingsSaving ? '正在保存…' : '保存识别配置' }}</button></div>
      </form>
    </section>
    <div class="workspace">
      <section class="preview">
        <div class="section-title"><h2>视频预览</h2><span class="preview-label">{{ previewResult ? `裁剪结果 · ${previewResult.media.name}` : '源视频' }}</span></div>
        <div class="screen">
          <video v-if="active" :key="active.id" ref="video" :src="active.url" controls preload="metadata" @timeupdate="current = video?.currentTime ?? 0" @error="playbackError = '当前视频无法播放，可能是编码不受支持或文件已移动。可尝试裁剪为 MP4 后预览，或更换视频。'" />
          <div v-else class="empty"><span class="film">▷</span><h3>从一段视频开始</h3><p>导入本地视频，预览并截取你需要的部分</p><span class="muted">MP4 · MOV · MKV · WebM 等</span></div>
        </div>
        <p v-if="playbackError" class="error" role="alert">{{ playbackError }}</p>
        <div class="metadata"><strong>{{ active?.name || '尚未导入视频' }}</strong><span v-if="active">{{ active.width }} × {{ active.height }} · {{ active.fps.toFixed(2) }} fps · {{ formatTime(active.duration) }}{{ active.hasAudio ? '' : ' · 无音轨' }}</span></div>
        <div class="preview-footer"><span>当前位置 <b>{{ formatTime(current) }}</b></span><button v-if="previewResult" class="small" @click="switchPreview(null)">返回当前源视频</button></div>
      </section>
      <aside>
        <div class="section-title"><h2>裁剪范围</h2><span>当前片段</span></div>
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
      </aside>
    </div>
    <section class="status" aria-live="polite"><div><span class="status-dot" :class="{ done: progress === 100 && !busy, failed: error }"></span><strong>{{ message }}</strong><span v-if="busy"> {{ progress.toFixed(0) }}%</span></div><progress v-if="busy" :value="progress" max="100"/><p v-if="error" class="error" role="alert">{{ error }}</p></section>
    <section v-if="results.length" class="history" aria-labelledby="results-title">
      <div class="section-title"><h2 id="results-title">已生成片段 <span class="badge">{{ results.length }}</span></h2><span>按生成顺序 · 本次打开期间保留</span></div>
      <ol class="clip-list">
        <li v-for="(record, index) in results" :key="record.media.id" class="clip-record" :class="{ selected: previewResult?.media.id === record.media.id }">
          <span class="clip-number">{{ index + 1 }}</span>
          <div class="clip-info">
            <strong>{{ record.media.name }}</strong>
            <span>源视频：{{ record.source.name }}</span>
            <span>范围 {{ formatTime(record.start) }} → {{ formatTime(record.end) }} · 实际时长 {{ formatTime(record.media.duration) }}</span>
            <span class="clip-path">{{ record.output }}</span>
          </div>
          <div class="result-actions">
            <span v-if="previewResult?.media.id === record.media.id" class="previewing">正在预览</span>
            <button class="small" :disabled="importing" @click="switchPreview(record)">预览</button>
            <button class="small" @click="reveal(record)">打开所在文件夹</button>
          </div>
          <div class="recognition-panel">
            <div class="recognition-controls">
              <label>识别服务商<select v-model="record.provider" :disabled="recognizingIds.has(record.media.id)" :aria-label="`片段${index + 1}识别服务商`"><option value="aliyun">阿里云百炼</option><option value="volcengine">火山引擎</option></select></label>
              <label>音频语言<select v-model="record.language" :disabled="recognizingIds.has(record.media.id)" :aria-label="`片段${index + 1}音频语言`"><option v-for="language in languages" :key="language[0]" :value="language[0]">{{ language[1] }}</option></select></label>
              <button v-if="recognizingIds.has(record.media.id)" class="small" @click="cancelRecognition(record)">停止识别</button>
              <button v-else class="small" :disabled="!record.media.hasAudio || recognizingIds.size >= 2" @click="recognize(record)">{{ record.job?.result?.cues.length ? '重新识别原文' : record.job?.status === 'failed' || record.job?.status === 'cancelled' ? '重试识别' : '生成原文字幕' }}</button>
              <button v-if="record.job?.result?.cues.length" class="small" @click="record.subtitlesOpen = !record.subtitlesOpen">{{ record.subtitlesOpen ? '收起字幕' : `查看字幕（${record.job.result.cues.length}）` }}</button>
              <button v-if="record.job?.result?.cues.length" class="small" :disabled="exporting" @click="exportSrt(record)">导出原文 SRT</button>
            </div>
            <p class="muted hint">{{ record.media.hasAudio ? '生成字幕仅上传此片段的音频，按所选服务商计费；已提交任务的停止或重试可能仍产生费用。' : '此片段没有音轨，无法生成字幕。' }}</p>
            <p v-if="record.job" class="job-message" :class="{ error: record.job.status === 'failed', warning: record.job.status === 'cancelled' }" role="status">{{ record.job.message }}</p>
            <p v-if="record.exportMessage" class="export-message" role="status">{{ record.exportMessage }}</p>
            <div v-if="record.subtitlesOpen && record.job?.result?.cues.length" class="subtitles">
              <p class="muted">原文字幕 · {{ record.job.result.provider === 'aliyun' ? '阿里云百炼' : '火山引擎' }} · 时间以此片段的 0 秒为基准</p>
              <ol class="subtitle-list"><li v-for="(cue, cueIndex) in record.job.result.cues" :key="cueIndex"><span>{{ cueIndex + 1 }} · {{ formatTime(cue.start) }} → {{ formatTime(cue.end) }}</span><p>{{ cue.text }}</p></li></ol>
            </div>
          </div>
        </li>
      </ol>
    </section>
    <footer>裁剪在本地处理 · 识别仅上传所选片段音频<span>第二阶段 / 原文字幕识别</span></footer>
  </main>
</template>

<style>
:root{font-family:Segoe UI,Microsoft YaHei,sans-serif;color:#e5ebf5;background:#10151f;font-synthesis:none;color-scheme:dark}*{box-sizing:border-box}body{margin:0}button,input{font:inherit}button{border:1px solid #354257;background:#242f40;color:#e5ebf5;border-radius:8px;padding:11px 16px;cursor:pointer}button:hover:not(:disabled){background:#33435c}button:disabled{opacity:.4;cursor:not-allowed}main{max-width:1440px;margin:auto;padding:32px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:30px}.eyebrow{font-size:11px;letter-spacing:2px;color:#8c9bb0}h1{font-size:25px;letter-spacing:1px;margin:9px 0}h2{font-size:15px;margin:0}.badge{vertical-align:middle;font-size:11px;letter-spacing:0;color:#91b6ff;background:#233454;border-radius:5px;padding:5px 8px;margin-left:14px}.primary{background:#608dff;border-color:#608dff;color:#07142e;font-weight:650}.primary:hover:not(:disabled){background:#88aaff}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:22px}.preview,aside,.status{border:1px solid #2b3546;background:#19212e;border-radius:12px}.preview{overflow:hidden;align-self:start}.section-title{display:flex;justify-content:space-between;align-items:center;padding:19px 22px}.section-title>span,.muted{color:#8c9bb0;font-size:12px}.screen{background:#080b10;aspect-ratio:16/9;display:flex;align-items:center;justify-content:center}video{width:100%;height:100%;max-height:62vh}.empty{text-align:center;color:#b7c3d5}.film{font-size:48px;color:#6c8dbe}.empty h3{font-size:18px;margin:14px 0}.empty p{font-size:13px}.metadata{padding:19px 22px;display:flex;flex-direction:column;gap:7px;overflow-wrap:anywhere}.metadata strong{font-size:14px}.metadata span{color:#8c9bb0;font-size:12px}.preview-footer{padding:13px 22px;border-top:1px solid #2b3546;display:flex;align-items:center;justify-content:space-between;font-size:12px;color:#9baac0}.preview-footer b{margin-left:10px;color:#dde7f6;font-variant-numeric:tabular-nums}fieldset{border:0;padding:0 22px 23px;margin:0;min-width:0}label{display:block;font-size:13px;color:#bac7da;margin:18px 0 9px}.time-row{display:flex;gap:8px}input{width:0;flex:1;background:#111925;color:#e5ebf5;border:1px solid #3a4961;border-radius:7px;padding:11px;font-variant-numeric:tabular-nums;min-width:0}input:focus{outline:2px solid #608dff}.small{font-size:12px;padding:8px 11px;white-space:nowrap}.hint{line-height:1.8;margin:12px 0}.duration{display:flex;justify-content:space-between;background:#111925;border-radius:8px;padding:17px 12px;margin:20px 0;font-size:12px;color:#aebbd0}.duration strong{color:#99b8ff;font-variant-numeric:tabular-nums}.output{width:100%;text-align:left;font-size:12px;overflow-wrap:anywhere}.wide{width:100%;margin-top:10px}.status{margin-top:22px;padding:19px 22px;font-size:13px}.status-dot{display:inline-block;width:8px;height:8px;background:#719bed;border-radius:50%;margin-right:10px}.done{background:#75d5a2}.failed{background:#ff8e8e}.error{color:#ffabab;font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}.preview>.error{margin:14px 22px}progress{width:100%;height:8px;margin-top:16px;accent-color:#608dff}.result-actions{display:flex;gap:10px;margin-top:16px}.result-actions button{font-size:12px}footer{display:flex;justify-content:space-between;color:#65768e;font-size:11px;margin-top:22px}@media(max-width:950px){main{padding:20px}.workspace{grid-template-columns:minmax(0,1fr) 310px}.section-title{padding:16px}fieldset{padding:0 16px 20px}}
.preview-label{max-width:70%;text-align:right;overflow-wrap:anywhere}.warning{color:#edc482;font-size:12px;line-height:1.7}.history{margin-top:22px;border:1px solid #2b3546;background:#19212e;border-radius:12px;overflow:hidden}.clip-list{margin:0;padding:0;list-style:none}.clip-record{display:flex;align-items:center;gap:16px;padding:20px 22px;border-top:1px solid #2b3546}.clip-record.selected{background:#20304a}.clip-number{align-self:flex-start;color:#8c9bb0;font-size:13px;min-width:18px;padding-top:2px;font-variant-numeric:tabular-nums}.clip-info{display:flex;flex:1;min-width:0;flex-direction:column;gap:7px;overflow-wrap:anywhere}.clip-info strong{font-size:14px}.clip-info>span{font-size:12px;color:#aab8cd}.clip-info>.clip-path{font-size:11px;color:#8194b0}.clip-record .result-actions{margin:0;flex-wrap:wrap;justify-content:flex-end;align-items:center;max-width:270px}.previewing{font-size:11px;color:#99b8ff}@media(max-width:950px){.clip-record{flex-wrap:wrap}.clip-record .result-actions{margin-left:34px;max-width:none;width:100%;justify-content:flex-start}}
.header-actions{display:flex;gap:10px;align-items:center}.settings{border:1px solid #2b3546;background:#19212e;border-radius:12px;margin-bottom:24px}.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:32px}.settings-grid h3{font-size:15px}.settings-grid input:not([type=checkbox]){display:block;width:100%}.settings-grid select{width:100%}.settings-footer{padding:0 22px 22px}.settings-footer button{margin-top:8px}.check{display:flex;align-items:center;gap:8px;font-size:12px}.check input{width:16px;height:16px;flex:none}select{font:inherit;background:#111925;color:#e5ebf5;border:1px solid #3a4961;border-radius:7px;padding:10px;max-width:100%}select:focus{outline:2px solid #608dff}select:disabled{opacity:.5}.clip-record{flex-wrap:wrap}.recognition-panel{flex-basis:100%;min-width:0;margin-left:34px;padding-top:12px;border-top:1px dashed #354257}.recognition-controls{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}.recognition-controls label{font-size:11px;margin:0}.recognition-controls select{display:block;margin-top:7px;min-width:130px;font-size:12px}.recognition-controls button{min-height:37px}.job-message,.export-message{font-size:12px;line-height:1.8;overflow-wrap:anywhere}.export-message{color:#9ac5f5}.subtitles{margin-top:14px;padding:12px 16px;background:#111925;border-radius:8px}.subtitle-list{list-style:none;padding:0;margin:0;max-height:360px;overflow:auto}.subtitle-list li{border-top:1px solid #2b3546;padding:12px 0}.subtitle-list span{font-size:11px;color:#8fa4c4;font-variant-numeric:tabular-nums}.subtitle-list p{font-size:13px;line-height:1.7;white-space:pre-wrap;margin:7px 0 0}@media(max-width:950px){.settings-grid{gap:20px}.header-actions button{font-size:12px;padding:10px}.recognition-panel{margin-left:0}}
</style>
