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
export type SubtitleExportInput = string | { mediaId: string; speakerId: number | null; recognitionId?: string }
export interface IpcMap {
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
