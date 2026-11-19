import { build as compile } from 'esbuild'
import { spawn, execFileSync } from 'node:child_process'
import { copyFile, mkdir, readdir, access, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

async function prepareDownloadTools(root: string) {
  const destination = join(root, '.packaging', 'downloader')
  const cache = join(root, '.packaging', 'downloads')
  await mkdir(destination, { recursive: true })
  await mkdir(cache, { recursive: true })
  const releases = [
    { name: 'yt-dlp', version: '2026.10.26', file: 'yt-dlp.exe', sha256: 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d', url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe' },
    { name: 'deno', version: '2.9.8', file: 'deno.zip', sha256: 'cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf', url: 'https://github.com/denoland/deno/releases/download/v2.9.8/deno-x86_64-pc-windows-msvc.zip' }
  ]
  for (const release of releases) {
    const path = join(cache, `${release.name}-${release.version}-${release.file}`)
    let bytes = await readFile(path).catch(() => undefined)
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== release.sha256) {
      console.log(`正在获取 ${release.name} ${release.version}…`)
      const response = await fetch(release.url, { signal: AbortSignal.timeout(5 * 60 * 1000) })
      if (!response.ok) throw new Error(`下载 ${release.name} 失败：HTTP ${response.status}`)
      bytes = Buffer.from(await response.arrayBuffer())
      if (createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error(`${release.name} SHA-256 校验失败，未安装该文件。`)
      await writeFile(path, bytes)
    }
    if (release.name === 'yt-dlp') await copyFile(path, join(destination, 'yt-dlp.exe'))
    else {
      const stage = await mkdtemp(join(cache, 'deno-extract-'))
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath '${path.replace(/'/g, "''")}' -DestinationPath '${stage.replace(/'/g, "''")}' -Force`], { windowsHide: true, timeout: 60000, stdio: 'pipe' })
        await copyFile(join(stage, 'deno.exe'), join(destination, 'deno.exe'))
      } finally {
        if (dirname(resolve(stage)) === resolve(cache) && basename(stage).startsWith('deno-extract-')) await rm(stage, { recursive: true, force: true })
      }
    }
  }
  const licenses = [
    { name: 'YT-DLP-LICENSE.txt', url: 'https://raw.githubusercontent.com/yt-dlp/yt-dlp/2026.10.26/LICENSE', sha256: '7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c' },
    { name: 'YT-DLP-THIRD-PARTY-LICENSES.txt', url: 'https://raw.githubusercontent.com/yt-dlp/yt-dlp/2026.10.26/THIRD_PARTY_LICENSES.txt', sha256: '472aefe951c7db35e1657c1d13fd337140511ed6f2b329205105ad441c5a02b7' },
    { name: 'DENO-LICENSE.txt', url: 'https://raw.githubusercontent.com/denoland/deno/v2.9.8/LICENSE.md', sha256: 'f62497fffecc0852960c8d3e6934b9db86d16396e9b604072e923892cae3a588' }
  ]
  for (const { name, url, sha256 } of licenses) {
    const path = join(destination, name)
    const cached = await readFile(path).catch(() => undefined)
    if (cached && createHash('sha256').update(cached).digest('hex') === sha256) continue
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`无法获取 ${name}：HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`${name} 校验失败。`)
    await writeFile(path, bytes)
  }
  const ytDlpVersion = execFileSync(join(destination, 'yt-dlp.exe'), ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim()
  const denoVersion = execFileSync(join(destination, 'deno.exe'), ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim()
  if (ytDlpVersion !== releases[0].version || !denoVersion.startsWith(`deno ${releases[1].version} `)) throw new Error('下载工具版本检查失败。')
  const binaries = []
  for (const name of ['yt-dlp.exe', 'deno.exe']) binaries.push({ name, sha256: createHash('sha256').update(await readFile(join(destination, name))).digest('hex') })
  await writeFile(join(destination, 'DOWNLOAD-TOOLS.json'), JSON.stringify({ ytDlpVersion, denoVersion, releases, licenses, binaries }, null, 2), 'utf8')
  await writeFile(join(destination, 'NOTICE.txt'), 'yt-dlp and Deno are independent third-party programs.\nUpstream: https://github.com/yt-dlp/yt-dlp and https://github.com/denoland/deno\nSee the included license files and DOWNLOAD-TOOLS.json for licenses, pinned sources, versions and checksums.\nThe official yt-dlp.exe bundles third-party components; its combined license includes GPLv3+.\n', 'utf8')
  console.log(`下载工具已就绪：yt-dlp ${ytDlpVersion}、${denoVersion.split('\n')[0]}。`)
}

async function main() {
  const mode = process.argv[2]
  if (process.platform !== 'win32' || !['tools', 'dir', 'win'].includes(mode)) throw new Error('请在 Windows 上使用 npm run setup:downloader、npm run package:dir 或 npm run package:win。')
  const root = resolve(__dirname, '..')
  process.chdir(root)
  await prepareDownloadTools(root)
  if (mode === 'tools') return
  const bin = process.env.FFMPEG_DIR || dirname(execFileSync('where.exe', ['ffmpeg.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0])
  const license = join(dirname(bin), 'LICENSE.txt')
  for (const file of [join(bin, 'ffmpeg.exe'), join(bin, 'ffprobe.exe'), license]) await access(file).catch(() => { throw new Error(`缺少打包所需文件：${file}。请通过 FFMPEG_DIR 指定完整发行包的 bin 目录（上级需包含 LICENSE.txt）。`) })
  const destination = join(root, '.packaging', 'ffmpeg')
  await mkdir(destination, { recursive: true })
  for (const file of ['ffmpeg.exe', 'ffprobe.exe', ...(await readdir(bin)).filter(name => name.toLowerCase().endsWith('.dll'))]) await copyFile(join(bin, file), join(destination, basename(file)))
  await copyFile(license, join(destination, 'LICENSE.txt'))
  const version = execFileSync(join(bin, 'ffmpeg.exe'), ['-version'], { encoding: 'utf8', windowsHide: true })
  await writeFile(join(destination, 'FFMPEG-VERSION.txt'), version, 'utf8')
  await writeFile(join(destination, 'NOTICE.txt'), 'FFmpeg and ffprobe are independent third-party programs.\nUpstream: https://ffmpeg.org/\nThis distribution uses the included FFmpeg LICENSE.txt.\nBuild/version information is recorded in FFMPEG-VERSION.txt.\n', 'utf8')
  const { build: buildRenderer } = await import('vite')
  await buildRenderer()
  await compile({ entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' }, outdir: '.electron', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node22', external: ['electron'], sourcemap: false, minify: false })
  console.log(`生产文件与 FFmpeg 已准备，开始生成 ${mode === 'dir' ? '可运行目录' : 'Windows 安装包'}。`)
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/electron-builder/cli.js'), '--win', '--x64', ...(mode === 'dir' ? ['--dir'] : []), '--publish', 'never'], { stdio: 'inherit', windowsHide: true, env })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? done() : reject(new Error(`安装包生成失败，退出码 ${code}。`)))
  })
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
