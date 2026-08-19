/**
 * archive.ts — .dshmig（zip）打包/解包（docs §5 归档格式）。
 * 用 adm-zip：纯 JS、同步 API、无系统命令依赖（跨平台一致）。
 */
import AdmZip from 'adm-zip'
import { mkdirSync, renameSync } from 'node:fs'
import { basename, dirname } from 'node:path'

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

/** 读取 zip 内文本文件（manifest 等）。 */
export function readZipText(zipPath: string, entryPath: string): string {
  const zip = new AdmZip(zipPath)
  const entry = zip.getEntry(entryPath)
  if (!entry) throw new Error(`archive entry missing: ${entryPath}`)
  return entry.getData().toString('utf8')
}

/** 解包到目录；返回解出的文件相对路径列表。 */
export function extractArchive(zipPath: string, destDir: string): string[] {
  const zip = new AdmZip(zipPath)
  zip.extractAllTo(destDir, true)
  return zip.getEntries().map((e) => e.entryName).filter((n) => !n.endsWith('/'))
}
