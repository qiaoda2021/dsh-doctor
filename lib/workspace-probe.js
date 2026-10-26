/**
 * DSH Doctor — 工作区可写性探测。同步、零依赖；默认只做 stat + access(W_OK)。
 * access 成功只是权限预检，不保证后续写入成功（磁盘空间/ACL/并发状态仍可能变化）。
 * 只有 options.writeProbe === true 才在 cwd 创建随机 O_EXCL 文件，写入后 finally 清理。
 * options.fs 可注入 node:fs 的同步接口；注入后所有文件操作均只使用该实现。
 */
import * as nativeFs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

const WRITE_FAILURE_CODES = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EDQUOT', 'EIO'])
const MISSING_PATH_CODES = new Set(['ENOENT', 'ENOTDIR'])

function failureOf(error, stage) {
  const errorCode = typeof error?.code === 'string' && error.code ? error.code : undefined
  const message = typeof error?.message === 'string' ? error.message : String(error)
  return {
    writable: errorCode && WRITE_FAILURE_CODES.has(errorCode) ? false : undefined,
    ...(errorCode ? { errorCode } : {}),
    detail: `${stage}：${message}`,
  }
}

/**
 * @param {string|undefined} cwd
 * @param {{ writeProbe?: boolean, fs?: typeof import('node:fs') }} options
 * @returns {{ writable: boolean|undefined, errorCode?: string, detail?: string, cleanupFailed?: boolean }}
 */
export function probeWorkspaceWritable(cwd, options = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    return { writable: undefined, detail: '工作区路径缺失，未执行写入权限预检' }
  }
  const io = options?.fs ?? nativeFs
  try {
    if (!io.statSync(cwd).isDirectory()) {
      return { writable: undefined, errorCode: 'ENOTDIR', detail: '工作区路径不是目录，未执行写入权限预检' }
    }
  } catch (error) {
    const result = failureOf(error, 'stat')
    // 路径不存在/中间层不是目录是路径事实缺失，不是写入权限故障。
    if (MISSING_PATH_CODES.has(result.errorCode)) result.writable = undefined
    return result
  }

  if (options?.writeProbe !== true) {
    try {
      io.accessSync(cwd, nativeFs.constants.W_OK)
      return { writable: true, detail: 'access(W_OK) 权限预检通过；未创建工作区文件，未验证实际写入或剩余空间' }
    } catch (error) {
      return failureOf(error, 'access(W_OK)')
    }
  }

  let file
  let fd
  let created = false
  let stage = 'open(O_EXCL)'
  let result
  try {
    file = join(cwd, `.dsh-doctor-write-probe-${randomBytes(16).toString('hex')}.tmp`)
    fd = io.openSync(file, nativeFs.constants.O_WRONLY | nativeFs.constants.O_CREAT | nativeFs.constants.O_EXCL, 0o600)
    created = true
    stage = 'write'
    const payload = Buffer.from('DSH Doctor workspace write probe\n', 'utf8')
    const written = io.writeSync(fd, payload, 0, payload.length)
    if (written !== payload.length) {
      const error = new Error(`写入字节不足：${written}/${payload.length}`)
      error.code = 'EIO'
      throw error
    }
    result = { writable: true, detail: '随机 O_EXCL 文件实际写入成功' }
  } catch (error) {
    result = failureOf(error, stage)
  } finally {
    const cleanup = []
    if (created) {
      try {
        io.closeSync(fd)
      } catch (error) {
        cleanup.push(failureOf(error, 'close'))
      }
      // 只删本次 open(O_EXCL) 成功创建的文件；EEXIST/打开失败时绝不删既有文件。
      try {
        io.unlinkSync(file)
      } catch (error) {
        if (error?.code !== 'ENOENT') cleanup.push(failureOf(error, 'unlink'))
      }
    }
    if (cleanup.length) {
      result.cleanupFailed = true
      result.detail += `；清理未完整完成：${cleanup.map((item) => item.detail).join('；')}`
      if (!result.errorCode && cleanup[0].errorCode) result.errorCode = cleanup[0].errorCode
    }
  }
  return result
}
