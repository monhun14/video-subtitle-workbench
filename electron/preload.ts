import { contextBridge, ipcRenderer } from 'electron'
import type { WorkbenchAPI, IpcMap, Reply, SubtitleJob, TranslationJob, DownloadJob, DownloadAnalysis } from '../src/env'

function invoke<K extends keyof IpcMap>(channel: K, ...args: IpcMap[K]['args']): Promise<Reply<IpcMap[K]['result']>> {
  return ipcRenderer.invoke(channel, ...args)
}

const api: WorkbenchAPI = {
  chooseDownloadDirectory: () => invoke('download:directory'),
  analyzeDownload: input => invoke('download:analyze', input),
  chooseDownloadCookies: () => invoke('download:cookies'),
  clearDownloadCookies: () => invoke('download:cookies-clear'),
  cancelDownloadAnalysis: id => invoke('download:analysis-cancel', id),
  onDownloadAnalysis: callback => {
    const listener = (_event: Electron.IpcRendererEvent, analysis: DownloadAnalysis) => callback(analysis)
    ipcRenderer.on('download:analysis', listener)
    return () => ipcRenderer.removeListener('download:analysis', listener)
  },
  startDownload: input => invoke('download:start', input),
  cancelDownload: id => invoke('download:cancel', id),
  getDownload: () => invoke('download:get'),
  revealDownload: id => invoke('download:reveal', id),
  importDownload: id => invoke('download:import', id),
  onDownloadJob: callback => {
    const listener = (_event: Electron.IpcRendererEvent, job: DownloadJob) => callback(job)
    ipcRenderer.on('download:job', listener)
    return () => ipcRenderer.removeListener('download:job', listener)
  },
  importVideo: () => invoke('video:import'),
  chooseOutput: id => invoke('video:output', id),
  clip: input => invoke('video:clip', input),
  reveal: id => invoke('video:reveal', id),
  getSettings: () => invoke('settings:get'),
  saveSettings: input => invoke('settings:save', input),
  recognize: input => invoke('subtitles:recognize', input),
  cancelRecognition: id => invoke('subtitles:cancel', id),
  resolveReview: input => invoke('subtitles:review', input),
  exportSrt: input => invoke('subtitles:export', input),
  loadTranslationSource: input => invoke('translation:source', input),
  translate: input => invoke('translation:start', input),
  cancelTranslation: id => invoke('translation:cancel', id),
  exportTranslation: input => invoke('translation:export', input),
  onTranslationJob: callback => {
    const listener = (_event: Electron.IpcRendererEvent, job: TranslationJob) => callback(job)
    ipcRenderer.on('translation:job', listener)
    return () => ipcRenderer.removeListener('translation:job', listener)
  },
  onSubtitleJob: callback => {
    const listener = (_event: Electron.IpcRendererEvent, job: SubtitleJob) => callback(job)
    ipcRenderer.on('subtitles:job', listener)
    return () => ipcRenderer.removeListener('subtitles:job', listener)
  },
  onProgress: callback => {
    const listener = (_event: Electron.IpcRendererEvent, value: number) => callback(value)
    ipcRenderer.on('video:progress', listener)
    return () => ipcRenderer.removeListener('video:progress', listener)
  }
}
contextBridge.exposeInMainWorld('workbench', api)
