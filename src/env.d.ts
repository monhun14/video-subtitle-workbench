export interface MediaInfo { id: string; name: string; url: string; duration: number; width: number; height: number; fps: number; hasAudio: boolean }
export interface ClipResult extends MediaInfo { nextOutput: string; nextOutputWarning?: string }
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string }
export type Provider = 'aliyun' | 'volcengine'
export type AliyunRecognitionModel = 'qwen3-asr-flash-filetrans' | 'qwen-audio-3.1-asr-flash-filetrans' | 'fun-asr'
export interface SettingsUpdate {
  aliyun: { apiKey?: string; region: 'beijing' | 'singapore'; workspaceId: string; model?: AliyunRecognitionModel; clear?: boolean }
  volcengine: { apiKey?: string; appId: string; accessToken?: string; mode: 'apiKey' | 'legacy'; clear?: boolean }
  translation?: {
    aliyun: { apiKey?: string; region: 'beijing' | 'singapore'; workspaceId: string; model: string; clear?: boolean }
    volcengine: { apiKey?: string; model: string; clear?: boolean }
  }
}
export interface SettingsStatus {
  hasCredentials: boolean
  aliyun: { configured: boolean; hasApiKey: boolean; region: 'beijing' | 'singapore'; workspaceId: string; model: AliyunRecognitionModel }
  volcengine: { configured: boolean; hasApiKey: boolean; hasAccessToken: boolean; appId: string; mode: 'apiKey' | 'legacy' }
  translation: {
    aliyun: { configured: boolean; hasApiKey: boolean; region: 'beijing' | 'singapore'; workspaceId: string; model: string }
    volcengine: { configured: boolean; hasApiKey: boolean; model: string }
  }
}
export type TranslationSourceInput = { kind: 'recognized'; mediaId: string } | { kind: 'imported' }
export interface TranslationSource { id: string; name: string; kind: 'recognized' | 'imported'; cues: SubtitleCue[] }
export interface TranslationInput { sourceId: string; provider: Provider; targetLanguage: string; retryJobId?: string }
export interface TranslationJob {
  id: string; source: TranslationSource; provider: Provider; targetLanguage: string; model: string
  status: 'running' | 'completed' | 'partial' | 'cancelled'
  translations: (string | null)[]; errors: string[]; completed: number; message: string
}
export interface SubtitleCue { start: number; end: number; text: string; speakerId?: number }
export interface SubtitleReview { id: string; sourceIndex: number; text: string; start?: number; end?: number; speakerId?: number; reason: string; raw: unknown; status?: 'accepted' | 'discarded'; corrected?: { start: number; end: number } }
export type SubtitleReviewInput = { mediaId: string; reviewId: string } & ({ action: 'accept'; start: number; end: number } | { action: 'discard' })
export interface Transcript { provider: Provider; language: string; model?: AliyunRecognitionModel; recognitionId?: string; cues: SubtitleCue[]; createdAt: string }
export interface SubtitleJob {
  mediaId: string; provider: Provider; language: string; model?: AliyunRecognitionModel; recognitionId?: string
  status: 'extracting' | 'uploading' | 'recognizing' | 'succeeded' | 'failed' | 'cancelled'
  message: string; result?: Transcript; review?: SubtitleReview[]
}
export interface ClipInput { id: string; start: number; end: number; output: string }
export interface RecognitionInput { id: string; provider: Provider; language: string }
export interface DownloadQuality { id: string; label: string; width: number; height: number; fps?: number; dynamicRange: string }
export interface DownloadAnalysis {
  id: string; revision: number; url: string; status: 'analyzing' | 'ready' | 'failed' | 'cancelled'; message: string
  title?: string; duration?: number; qualities: DownloadQuality[]; expiresAt?: number
}
export interface DownloadInput { url: string; autoBest: boolean; analysisId?: string; qualityId?: string }
export interface DownloadJob {
  id: string; revision: number; url: string; directory: string
  status: 'resolving' | 'downloading' | 'processing' | 'verifying' | 'saving' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'
  message: string; title?: string; percent?: number; downloadedBytes?: number; totalBytes?: number; speed?: number; eta?: number
  stream?: 'video' | 'audio' | 'combined'; output?: string; warning?: string
  autoBest: boolean; qualityId: string; quality: string; actualResolution?: string
}
export interface DownloadState { directory: string; job?: DownloadJob; analysis?: DownloadAnalysis; cookiesName?: string }
export type SubtitleExportInput = string | { mediaId: string; speakerId: number | null; recognitionId?: string }
export interface IpcMap {
  'download:directory': { args: []; result: string | null }
  'download:analyze': { args: [input: { url: string; force?: boolean }]; result: DownloadAnalysis }
  'download:cookies': { args: []; result: string | null }
  'download:cookies-clear': { args: []; result: void }
  'download:analysis-cancel': { args: [id: string]; result: void }
  'download:start': { args: [input: DownloadInput]; result: DownloadJob }
  'download:cancel': { args: [id: string]; result: void }
  'download:get': { args: []; result: DownloadState }
  'download:reveal': { args: [id: string]; result: void }
  'download:import': { args: [id: string]; result: MediaInfo }
  'video:import': { args: []; result: MediaInfo | null }
  'video:output': { args: [id: string]; result: string | null }
  'video:clip': { args: [input: ClipInput]; result: ClipResult }
  'video:reveal': { args: [id: string]; result: void }
  'settings:get': { args: []; result: SettingsStatus }
  'settings:save': { args: [input: SettingsUpdate]; result: SettingsStatus }
  'subtitles:recognize': { args: [input: RecognitionInput]; result: SubtitleJob }
  'subtitles:cancel': { args: [id: string]; result: void }
  'subtitles:review': { args: [input: SubtitleReviewInput]; result: SubtitleJob }
  'subtitles:export': { args: [input: SubtitleExportInput]; result: string | null }
  'translation:source': { args: [input: TranslationSourceInput]; result: TranslationSource | null }
  'translation:start': { args: [input: TranslationInput]; result: TranslationJob }
  'translation:cancel': { args: [id: string]; result: void }
  'translation:export': { args: [input: { jobId: string; format: 'translated' | 'bilingual' }]; result: string | null }
}
export interface WorkbenchAPI {
  chooseDownloadDirectory(): Promise<Reply<string | null>>
  analyzeDownload(input: { url: string; force?: boolean }): Promise<Reply<DownloadAnalysis>>
  chooseDownloadCookies(): Promise<Reply<string | null>>
  clearDownloadCookies(): Promise<Reply<void>>
  cancelDownloadAnalysis(id: string): Promise<Reply<void>>
  onDownloadAnalysis(callback: (analysis: DownloadAnalysis) => void): () => void
  startDownload(input: DownloadInput): Promise<Reply<DownloadJob>>
  cancelDownload(id: string): Promise<Reply<void>>
  getDownload(): Promise<Reply<DownloadState>>
  revealDownload(id: string): Promise<Reply<void>>
  importDownload(id: string): Promise<Reply<MediaInfo>>
  onDownloadJob(callback: (job: DownloadJob) => void): () => void
  importVideo(): Promise<Reply<MediaInfo | null>>
  chooseOutput(id: string): Promise<Reply<string | null>>
  clip(input: ClipInput): Promise<Reply<ClipResult>>
  reveal(id: string): Promise<Reply<void>>
  onProgress(callback: (progress: number) => void): () => void
  getSettings(): Promise<Reply<SettingsStatus>>
  saveSettings(input: SettingsUpdate): Promise<Reply<SettingsStatus>>
  recognize(input: RecognitionInput): Promise<Reply<SubtitleJob>>
  cancelRecognition(id: string): Promise<Reply<void>>
  resolveReview(input: SubtitleReviewInput): Promise<Reply<SubtitleJob>>
  exportSrt(input: SubtitleExportInput): Promise<Reply<string | null>>
  onSubtitleJob(callback: (job: SubtitleJob) => void): () => void
  loadTranslationSource(input: TranslationSourceInput): Promise<Reply<TranslationSource | null>>
  translate(input: TranslationInput): Promise<Reply<TranslationJob>>
  cancelTranslation(id: string): Promise<Reply<void>>
  exportTranslation(input: { jobId: string; format: 'translated' | 'bilingual' }): Promise<Reply<string | null>>
  onTranslationJob(callback: (job: TranslationJob) => void): () => void
}
declare global { interface Window { workbench: WorkbenchAPI } }
