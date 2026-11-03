import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { context } from 'esbuild'
import electronPath from 'electron'

async function start() {
  const { createServer } = await import('vite')
  const server = await createServer()
  await server.listen()
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  let child: ChildProcess | undefined
  let closing = false
  let restarting = false
  const compiler = await context({
    entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' }, outdir: '.electron',
    outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node22',
    external: ['electron'], sourcemap: 'inline',
    plugins: [{ name: 'restart-electron', setup(build) {
      build.onEnd(async result => {
        if (result.errors.length || closing) return
        restarting = true
        if (child && child.exitCode === null) {
          const exited = once(child, 'exit')
          child.kill()
          await exited
        }
        restarting = false
        if (closing) return
        child = spawn(electronPath as unknown as string, ['.'], { stdio: 'inherit', env })
        child.once('error', error => { console.error('桌面程序启动失败：', error.message); void shutdown(1) })
        child.once('exit', code => { if (!restarting && !closing) void shutdown(code ?? 0) })
      })
    } }]
  })
  async function shutdown(code: number) {
    if (closing) return
    closing = true
    child?.kill()
    await Promise.all([compiler.dispose(), server.close()])
    process.exit(code)
  }
  process.once('SIGINT', () => void shutdown(0))
  process.once('SIGTERM', () => void shutdown(0))
  await compiler.watch()
}
start().catch(error => { console.error(error); process.exit(1) })
