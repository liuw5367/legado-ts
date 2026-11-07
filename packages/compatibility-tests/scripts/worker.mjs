import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { validateResult } from './common.mjs'

// 每个进程串行处理案例；超时或协议损坏后终止进程，下一例启动全新进程。
export class Worker {
  constructor(command, args, options = {}) {
    this.command = command
    this.args = args
    this.timeoutMs = options.timeoutMs ?? 5000
    this.cwd = options.cwd
    this.stderr = ''
  }
  start() {
    const child = spawn(this.command, this.args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.stdin.on('error', () => {})
    child.stderr.on('data', (data) => { this.stderr = (this.stderr + data).slice(-64_000) })
    child.on('error', (error) => this.pending?.reject(error))
    child.on('close', (code, signal) => {
      if (this.child === child) this.child = undefined
      this.pending?.reject(new Error(`执行器退出: ${code ?? signal}; ${this.stderr.slice(-1000)}`))
    })
    const reader = createInterface({ input: child.stdout })
    reader.on('line', (line) => {
      try {
        if (!this.pending) return
        const result = validateResult(JSON.parse(line), this.pending.id)
        this.pending.resolve(result)
      } catch (error) { this.pending?.reject(error) }
    })
  }
  async run(item) {
    if (!this.child) this.start()
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`案例超时: ${this.timeoutMs}ms`)), this.timeoutMs)
        this.pending = { id: item.id, resolve: (result) => { clearTimeout(timer); resolve(result) }, reject: (error) => { clearTimeout(timer); reject(error) } }
        this.child.stdin.write(JSON.stringify(item) + '\n')
      })
    } catch (error) {
      await this.close()
      return { id: item.id, execution: 'runner-failed', reason: error.message }
    } finally { this.pending = undefined }
  }
  async close() {
    const child = this.child
    if (!child) return
    this.child = undefined
    this.pending = undefined
    await new Promise((done) => { child.once('close', done); child.kill('SIGKILL') })
  }
}
