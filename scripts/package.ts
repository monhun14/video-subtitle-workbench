import { build as compile } from 'esbuild'
import { spawn, execFileSync } from 'node:child_process'
import { copyFile, mkdir, readdir, access, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

async function main() {
  const mode = process.argv[2]
  if (process.platform !== 'win32' || !['dir', 'win'].includes(mode)) throw new Error('请在 Windows 上使用 npm run package:dir 或 npm run package:win。')
  const root = resolve(__dirname, '..')
  process.chdir(root)
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
  console.log(`生产文件与 FFmpeg 已准备，开始生成 ${mode === 'dir' ? '可运行目录' : 'release1.0 安装包'}。`)
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/electron-builder/cli.js'), '--win', '--x64', ...(mode === 'dir' ? ['--dir'] : []), '--publish', 'never'], { stdio: 'inherit', windowsHide: true, env })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? done() : reject(new Error(`安装包生成失败，退出码 ${code}。`)))
  })
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
