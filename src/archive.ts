/**
 * archive.ts — .dshmig（zip）打包/解包（docs §5 归档格式）。
 * 用 adm-zip：纯 JS、同步 API、无系统命令依赖（跨平台一致）。
 * 2026-08-19 增（SECURITY_REVIEW F5）：解包前对条目数与总未压缩大小做上限预检，
 * 防 zip bomb 内存/磁盘 DoS；manifest 读取也限大小。
 */
import AdmZip from 'adm-zip'
import { mkdirSync, renameSync } from 'node:fs'
import { basename, dirname } from 'node:path'

// F5 上限：条目数 / 总未压缩大小（读 central directory 的 uncompressedSize 求和）/ 单文本条目
export const MAX_ZIP_ENTRIES = 10_000
export const MAX_UNCOMPRESSED_TOTAL = 512 * 1024 * 1024
export const MAX_TEXT_ENTRY_BYTES = 16 * 1024 * 1024

export interface ArchiveEntry {
  path: string             // 归档内路径（正斜杠）
  absPath?: string         // 从磁盘读取
  content?: string | Buffer // 直接内容（脱敏文本等）
}

export function createArchive(entries: ArchiveEntry[], outPath: string): void {
  const zip = new AdmZip()
  for (const e of entries) {
    if (e.content !== undefined) {
      zip.addFile(e.path, Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, 'utf8'))
    } else if (e.absPath) {
      zip.addLocalFile(e.absPath, dirname(e.path), basename(e.path))
    }
  }
  const tmp = outPath + '.tmp'
  zip.writeZip(tmp)
  mkdirSync(dirname(outPath), { recursive: true })
  renameSync(tmp, outPath)
}

/** 解包前预检：条目数 / 总未压缩大小上限（防 zip bomb，F5）。 */
function assertArchiveWithinLimits(zip: AdmZip): void {
  const entries = zip.getEntries()
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`archive has too many entries (${entries.length} > ${MAX_ZIP_ENTRIES})`)
  }
  let total = 0
  for (const e of entries) {
    const sz = e.header?.size ?? 0
    total += sz
    if (total > MAX_UNCOMPRESSED_TOTAL) {
      throw new Error(`archive uncompressed size exceeds limit (${total} > ${MAX_UNCOMPRESSED_TOTAL})`)
    }
  }
}

/** 读取 zip 内文本文件（manifest 等）。 */
export function readZipText(zipPath: string, entryPath: string): string {
  const zip = new AdmZip(zipPath)
  const entry = zip.getEntry(entryPath)
  if (!entry) throw new Error(`archive entry missing: ${entryPath}`)
  const sz = entry.header?.size ?? 0
  if (sz > MAX_TEXT_ENTRY_BYTES) throw new Error(`archive entry too large: ${entryPath} (${sz} bytes)`)
  return entry.getData().toString('utf8')
}

/** 解包到目录；返回解出的文件相对路径列表。 */
export function extractArchive(zipPath: string, destDir: string): string[] {
  const zip = new AdmZip(zipPath)
  assertArchiveWithinLimits(zip)
  zip.extractAllTo(destDir, true)
  return zip.getEntries().map((e) => e.entryName).filter((n) => !n.endsWith('/'))
}
