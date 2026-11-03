import { contextBridge, ipcRenderer } from 'electron'
import type { WorkbenchAPI, IpcMap, Reply, SubtitleJob } from '../src/env'

function invoke<K extends keyof IpcMap>(channel: K, ...args: IpcMap[K]['args']): Promise<Reply<IpcMap[K]['result']>> {
  return ipcRenderer.invoke(channel, ...args)
}

const api: WorkbenchAPI = {
  importVideo: () => invoke('video:import'),
  chooseOutput: id => invoke('video:output', id),
  clip: input => invoke('video:clip', input),
  reveal: id => invoke('video:reveal', id),
  getSettings: () => invoke('settings:get'),
  saveSettings: input => invoke('settings:save', input),
  recognize: input => invoke('subtitles:recognize', input),
  cancelRecognition: id => invoke('subtitles:cancel', id),
  exportSrt: id => invoke('subtitles:export', id),
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
