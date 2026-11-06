import { app, safeStorage } from 'electron'
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AliyunRecognitionModel, SettingsStatus, SettingsUpdate } from '../src/env'

export interface Credentials {
  aliyun: { apiKey: string; region: 'beijing' | 'singapore'; workspaceId: string; model: AliyunRecognitionModel }
  volcengine: { apiKey: string; appId: string; accessToken: string; mode: 'apiKey' | 'legacy' }
  translation: {
    aliyun: { apiKey: string; region: 'beijing' | 'singapore'; workspaceId: string; model: string }
    volcengine: { apiKey: string; model: string }
  }
}
const recognitionModels: AliyunRecognitionModel[] = ['qwen3-asr-flash-filetrans', 'qwen-audio-3.1-asr-flash-filetrans', 'fun-asr']
let settings: Credentials = {
  aliyun: { apiKey: '', region: 'beijing', workspaceId: '', model: 'qwen3-asr-flash-filetrans' },
  volcengine: { apiKey: '', appId: '', accessToken: '', mode: 'apiKey' },
  translation: { aliyun: { apiKey: '', region: 'beijing', workspaceId: '', model: 'qwen-mt-plus' }, volcengine: { apiKey: '', model: '' } }
}
let loadError = ''
let saving = false

export async function loadSettings() {
  try {
    const encrypted = await readFile(join(app.getPath('userData'), 'speech-settings.bin'))
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用')
    const value = JSON.parse(safeStorage.decryptString(encrypted)) as Credentials
    if (!value?.aliyun || !value?.volcengine || !['beijing', 'singapore'].includes(value.aliyun.region) || !['apiKey', 'legacy'].includes(value.volcengine.mode) || [value.aliyun.apiKey, value.aliyun.workspaceId, value.volcengine.apiKey, value.volcengine.appId, value.volcengine.accessToken].some(field => typeof field !== 'string')) throw new Error('配置格式无效')
    value.aliyun.model ??= 'qwen3-asr-flash-filetrans'
    if (!recognitionModels.includes(value.aliyun.model)) throw new Error('识别模型无效')
    value.translation ??= structuredClone(settings.translation)
    if (!value.translation.aliyun || !value.translation.volcengine || !['beijing', 'singapore'].includes(value.translation.aliyun.region) || [value.translation.aliyun.apiKey, value.translation.aliyun.workspaceId, value.translation.aliyun.model, value.translation.volcengine.apiKey, value.translation.volcengine.model].some(field => typeof field !== 'string')) throw new Error('翻译配置格式无效')
    settings = value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') loadError = '无法读取已保存的识别配置，请重新填写并保存。'
  }
}

export function getSettings(): SettingsStatus {
  if (loadError) throw new Error(loadError)
  return {
    aliyun: { configured: !!settings.aliyun.apiKey, region: settings.aliyun.region, workspaceId: settings.aliyun.workspaceId, model: settings.aliyun.model },
    volcengine: { configured: settings.volcengine.mode === 'apiKey' ? !!settings.volcengine.apiKey : !!(settings.volcengine.appId && settings.volcengine.accessToken), appId: settings.volcengine.appId, mode: settings.volcengine.mode },
    translation: {
      aliyun: { configured: !!settings.translation.aliyun.apiKey, region: settings.translation.aliyun.region, workspaceId: settings.translation.aliyun.workspaceId, model: settings.translation.aliyun.model },
      volcengine: { configured: !!(settings.translation.volcengine.apiKey && settings.translation.volcengine.model), model: settings.translation.volcengine.model }
    }
  }
}

export async function saveSettings(input: SettingsUpdate): Promise<SettingsStatus> {
  if (saving) throw new Error('正在保存配置，请稍候。')
  if (!input?.aliyun || !input?.volcengine || !['beijing', 'singapore'].includes(input.aliyun.region) || !['apiKey', 'legacy'].includes(input.volcengine.mode)) throw new Error('服务商配置无效。')
  if (input.aliyun.model !== undefined && !recognitionModels.includes(input.aliyun.model)) throw new Error('请选择有效的阿里云识别模型。')
  if (typeof input.aliyun.workspaceId !== 'string' || typeof input.volcengine.appId !== 'string') throw new Error('配置字段无效，请检查后重试。')
  for (const value of [input.aliyun.apiKey, input.aliyun.workspaceId, input.volcengine.apiKey, input.volcengine.appId, input.volcengine.accessToken]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 2048 || /[\r\n]/.test(value))) throw new Error('配置字段无效，请检查后重试。')
  }
  if (input.aliyun.workspaceId && !/^[a-zA-Z0-9-]+$/.test(input.aliyun.workspaceId)) throw new Error('阿里云业务空间 ID 仅支持字母、数字和连字符。')
  if (input.translation) {
    const { aliyun, volcengine } = input.translation
    if (!aliyun || !volcengine || !['beijing', 'singapore'].includes(aliyun.region) || typeof aliyun.workspaceId !== 'string' || !/^[a-zA-Z0-9-]*$/.test(aliyun.workspaceId) || !['qwen-mt-plus', 'qwen-mt-flash', 'qwen-mt-lite', 'qwen-mt-turbo'].includes(aliyun.model) || typeof volcengine.model !== 'string' || !/^[a-zA-Z0-9._:-]{0,160}$/.test(volcengine.model)) throw new Error('翻译服务配置无效，请检查地域、业务空间 ID 和模型。')
    for (const key of [aliyun.apiKey, volcengine.apiKey]) if (key !== undefined && (typeof key !== 'string' || key.length > 2048 || /[\r\n]/.test(key))) throw new Error('翻译凭证格式无效。')
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 加密服务不可用，凭证未保存，请检查当前用户环境。')
  const next: Credentials = {
    aliyun: { apiKey: input.aliyun.clear ? '' : input.aliyun.apiKey?.trim() || settings.aliyun.apiKey, region: input.aliyun.region, workspaceId: input.aliyun.workspaceId.trim(), model: input.aliyun.model ?? settings.aliyun.model },
    volcengine: { apiKey: input.volcengine.clear ? '' : input.volcengine.apiKey?.trim() || settings.volcengine.apiKey,
      accessToken: input.volcengine.clear ? '' : input.volcengine.accessToken?.trim() || settings.volcengine.accessToken,
      appId: input.volcengine.appId.trim(), mode: input.volcengine.mode },
    translation: input.translation ? {
      aliyun: { apiKey: input.translation.aliyun.clear ? '' : input.translation.aliyun.apiKey?.trim() || settings.translation.aliyun.apiKey, region: input.translation.aliyun.region, workspaceId: input.translation.aliyun.workspaceId.trim(), model: input.translation.aliyun.model },
      volcengine: { apiKey: input.translation.volcengine.clear ? '' : input.translation.volcengine.apiKey?.trim() || settings.translation.volcengine.apiKey, model: input.translation.volcengine.model }
    } : structuredClone(settings.translation)
  }
  const directory = app.getPath('userData')
  const temporary = join(directory, `speech-settings-${randomUUID()}.tmp`)
  saving = true
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(temporary, safeStorage.encryptString(JSON.stringify(next)), { flag: 'wx' })
    await rename(temporary, join(directory, 'speech-settings.bin'))
    settings = next
    loadError = ''
    return getSettings()
  } catch { throw new Error('配置保存失败，请检查用户配置目录的写入权限。') }
  finally { saving = false; await unlink(temporary).catch(() => {}) }
}

export function getCredentials(): Credentials {
  if (loadError) throw new Error(loadError)
  return structuredClone(settings)
}
