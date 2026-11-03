import { app, safeStorage } from 'electron'
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SettingsStatus, SettingsUpdate } from '../src/env'

export interface Credentials {
  aliyun: { apiKey: string; region: 'beijing' | 'singapore'; workspaceId: string }
  volcengine: { apiKey: string; appId: string; accessToken: string; mode: 'apiKey' | 'legacy' }
}
let settings: Credentials = {
  aliyun: { apiKey: '', region: 'beijing', workspaceId: '' },
  volcengine: { apiKey: '', appId: '', accessToken: '', mode: 'apiKey' }
}
let loadError = ''
let saving = false

export async function loadSettings() {
  try {
    const encrypted = await readFile(join(app.getPath('userData'), 'speech-settings.bin'))
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用')
    const value = JSON.parse(safeStorage.decryptString(encrypted)) as Credentials
    if (!value?.aliyun || !value?.volcengine || !['beijing', 'singapore'].includes(value.aliyun.region) || !['apiKey', 'legacy'].includes(value.volcengine.mode) || [value.aliyun.apiKey, value.aliyun.workspaceId, value.volcengine.apiKey, value.volcengine.appId, value.volcengine.accessToken].some(field => typeof field !== 'string')) throw new Error('配置格式无效')
    settings = value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') loadError = '无法读取已保存的识别配置，请重新填写并保存。'
  }
}

export function getSettings(): SettingsStatus {
  if (loadError) throw new Error(loadError)
  return {
    aliyun: { configured: !!settings.aliyun.apiKey, region: settings.aliyun.region, workspaceId: settings.aliyun.workspaceId },
    volcengine: { configured: settings.volcengine.mode === 'apiKey' ? !!settings.volcengine.apiKey : !!(settings.volcengine.appId && settings.volcengine.accessToken), appId: settings.volcengine.appId, mode: settings.volcengine.mode }
  }
}

export async function saveSettings(input: SettingsUpdate): Promise<SettingsStatus> {
  if (saving) throw new Error('正在保存配置，请稍候。')
  if (!input?.aliyun || !input?.volcengine || !['beijing', 'singapore'].includes(input.aliyun.region) || !['apiKey', 'legacy'].includes(input.volcengine.mode)) throw new Error('服务商配置无效。')
  if (typeof input.aliyun.workspaceId !== 'string' || typeof input.volcengine.appId !== 'string') throw new Error('配置字段无效，请检查后重试。')
  for (const value of [input.aliyun.apiKey, input.aliyun.workspaceId, input.volcengine.apiKey, input.volcengine.appId, input.volcengine.accessToken]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 2048 || /[\r\n]/.test(value))) throw new Error('配置字段无效，请检查后重试。')
  }
  if (input.aliyun.workspaceId && !/^[a-zA-Z0-9-]+$/.test(input.aliyun.workspaceId)) throw new Error('阿里云业务空间 ID 仅支持字母、数字和连字符。')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 加密服务不可用，凭证未保存，请检查当前用户环境。')
  const next: Credentials = {
    aliyun: { apiKey: input.aliyun.clear ? '' : input.aliyun.apiKey?.trim() || settings.aliyun.apiKey, region: input.aliyun.region, workspaceId: input.aliyun.workspaceId.trim() },
    volcengine: { apiKey: input.volcengine.clear ? '' : input.volcengine.apiKey?.trim() || settings.volcengine.apiKey,
      accessToken: input.volcengine.clear ? '' : input.volcengine.accessToken?.trim() || settings.volcengine.accessToken,
      appId: input.volcengine.appId.trim(), mode: input.volcengine.mode }
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
