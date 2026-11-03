export interface MediaInfo { id: string; name: string; url: string; duration: number; width: number; height: number; fps: number; hasAudio: boolean }
export interface ClipResult extends MediaInfo { nextOutput: string; nextOutputWarning?: string }
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string }
export type Provider = 'aliyun' | 'volcengine'
export interface SettingsUpdate {
  aliyun: { apiKey?: string; region: 'beijing' | 'singapore'; workspaceId: string; clear?: boolean }
  volcengine: { apiKey?: string; appId: string; accessToken?: string; mode: 'apiKey' | 'legacy'; clear?: boolean }
}
export interface SettingsStatus {
  aliyun: { configured: boolean; region: 'beijing' | 'singapore'; workspaceId: string }
  volcengine: { configured: boolean; appId: string; mode: 'apiKey' | 'legacy' }
}
export interface SubtitleCue { start: number; end: number; text: string }
export interface Transcript { provider: Provider; language: string; cues: SubtitleCue[]; createdAt: string }
export interface SubtitleJob {
  mediaId: string; provider: Provider; language: string
  status: 'extracting' | 'uploading' | 'recognizing' | 'succeeded' | 'failed' | 'cancelled'
  message: string; result?: Transcript
}
export interface ClipInput { id: string; start: number; end: number; output: string }
export interface RecognitionInput { id: string; provider: Provider; language: string }
export interface IpcMap {
  'video:import': { args: []; result: MediaInfo | null }
  'video:output': { args: [id: string]; result: string | null }
  'video:clip': { args: [input: ClipInput]; result: ClipResult }
  'video:reveal': { args: [id: string]; result: void }
  'settings:get': { args: []; result: SettingsStatus }
  'settings:save': { args: [input: SettingsUpdate]; result: SettingsStatus }
  'subtitles:recognize': { args: [input: RecognitionInput]; result: SubtitleJob }
  'subtitles:cancel': { args: [id: string]; result: void }
  'subtitles:export': { args: [id: string]; result: string | null }
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
  exportSrt(id: string): Promise<Reply<string | null>>
  onSubtitleJob(callback: (job: SubtitleJob) => void): () => void
}
declare global { interface Window { workbench: WorkbenchAPI } }
