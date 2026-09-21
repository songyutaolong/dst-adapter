import { existsSync, promises as fs } from 'fs'
import path from 'path'
import extractZip from 'extract-zip'
import yauzl from 'yauzl'
import type { RemoteSkillPackage } from '../../shared/types'
import type { ApplyResult } from '../../shared/types'
import { compareVersions } from './version'
import { migrateLegacySkillWorkDirectories } from './maintenance'

const MAX_ARCHIVE_ENTRIES = 10000
const MAX_EXTRACTED_SIZE = 400 * 1024 * 1024
const S_IFMT = 0o170000
const S_IFLNK = 0o120000

interface SkillArchiveMeta {
  root: string
  name: string
  version: string
  description?: string
}

function normalizedEntryName(entry: yauzl.Entry): string {
  return entry.fileName.replace(/\\/g, '/')
}

function assertSafeEntry(entry: yauzl.Entry): string {
  const name = normalizedEntryName(entry)
  if (!name || name.includes('\0') || name.includes(':')) {
    throw new Error('Skill 压缩包含非法文件名')
  }
  if (name.startsWith('/') || /^[a-z]:/i.test(name)) {
    throw new Error(`Skill 压缩包含绝对路径：${name}`)
  }

  const segments = name.split('/').filter(Boolean)
  if (segments.includes('..')) {
    throw new Error(`Skill 压缩包含越级路径：${name}`)
  }
  if (!segments.length) throw new Error('Skill 压缩包含空文件名')

  const mode = ((entry.externalFileAttributes >>> 16) & 0xffff)
  if ((mode & S_IFMT) === S_IFLNK) {
    throw new Error(`Skill 压缩包含符号链接：${name}`)
  }
  return segments.join('/')
}

async function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) reject(err || new Error('无法打开 Skill 压缩包'))
      else resolve(zipfile)
    })
  })
}

async function validateZipArchive(file: string): Promise<void> {
  const zipfile = await openZip(file)
  const entries: yauzl.Entry[] = []
  const names = new Set<string>()
  let totalSize = 0

  await new Promise<void>((resolve, reject) => {
    zipfile.on('error', reject)
    zipfile.on('entry', (entry: yauzl.Entry) => {
      try {
        const name = assertSafeEntry(entry)
        const isDirectory = entry.fileName.endsWith('/') ||
          ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o040000
        if (!isDirectory) {
          if (names.has(name)) throw new Error(`Skill 压缩包含重复文件：${name}`)
          names.add(name)
          totalSize += entry.uncompressedSize
        }
        entries.push(entry)
        if (entries.length > MAX_ARCHIVE_ENTRIES) {
          throw new Error(`Skill 压缩包文件数量超过限制：${MAX_ARCHIVE_ENTRIES}`)
        }
        if (totalSize > MAX_EXTRACTED_SIZE) {
          throw new Error(`Skill 解压后大小超过限制：${MAX_EXTRACTED_SIZE} 字节`)
        }
        zipfile.readEntry()
      } catch (err) {
        zipfile.close()
        reject(err)
      }
    })
    zipfile.on('end', resolve)
    zipfile.readEntry()
  })

  if (!entries.some((entry) => /(?:^|\/)SKILL\.md$/i.test(normalizedEntryName(entry)))) {
    throw new Error('Skill 压缩包缺少 SKILL.md')
  }
}

async function assertNoLinks(root: string): Promise<void> {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    const resolvedDir = path.resolve(dir)
    if (resolvedDir !== root && !resolvedDir.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Skill 解压路径越界：${resolvedDir}`)
    }

    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Skill 解压后包含符号链接：${full}`)
      if (entry.isDirectory()) stack.push(full)
    }
  }
}

function pickFrontmatterValue(frontmatter: string, field: string): string | undefined {
  const pattern = new RegExp(`^${field}:\\s*(?:"([^"]*)"|'([^']*)'|(.+))\\s*$`, 'mi')
  const match = pattern.exec(frontmatter)
  const value = match?.[1] || match?.[2] || match?.[3] || ''
  return value.trim() || undefined
}

function parseSkillMeta(raw: string): Omit<SkillArchiveMeta, 'root'> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!match) throw new Error('SKILL.md 缺少 frontmatter')

  const meta = {
    name: pickFrontmatterValue(match[1], 'name'),
    version: pickFrontmatterValue(match[1], 'version'),
    description: pickFrontmatterValue(match[1], 'description')
  }
  if (!meta.name) throw new Error('SKILL.md 缺少 name')
  if (!meta.version) throw new Error('SKILL.md 缺少 version')
  return meta as Required<Pick<SkillArchiveMeta, 'name' | 'version'>> & {
    description?: string
  }
}

async function locateSkillRoot(stageRoot: string): Promise<string> {
  if (existsSync(path.join(stageRoot, 'SKILL.md'))) return stageRoot

  const candidates: string[] = []
  for (const entry of await fs.readdir(stageRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue
    const skillFile = path.join(stageRoot, entry.name, 'SKILL.md')
    if (existsSync(skillFile)) candidates.push(path.join(stageRoot, entry.name))
  }

  if (candidates.length !== 1) {
    throw new Error(`无法在 Skill 压缩包中唯一定位 SKILL.md（找到 ${candidates.length} 个）`)
  }
  return candidates[0]
}

async function inspectSkillArchive(stageRoot: string): Promise<SkillArchiveMeta> {
  const root = await locateSkillRoot(stageRoot)
  const raw = await fs.readFile(path.join(root, 'SKILL.md'), 'utf-8')
  return { root, ...parseSkillMeta(raw) }
}

function assertInsideRoot(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Skill 安装目标越界：${target}`)
  }
}

async function removePath(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true, maxRetries: 3 })
}

export async function installSkillPackage(options: {
  skillsRoot: string
  targetDir: string
  remote: RemoteSkillPackage
  data: Buffer
  previousVersion?: string
  backupRoot: string
}): Promise<ApplyResult> {
  const { skillsRoot, remote, data, previousVersion } = options
  const root = path.resolve(skillsRoot)
  const target = path.resolve(options.targetDir)
  const backupRoot = path.resolve(options.backupRoot)
  assertInsideRoot(root, target)

  await fs.mkdir(root, { recursive: true })
  await migrateLegacySkillWorkDirectories({ skillsRoot: root, backupRoot })

  const stagingRoot = path.join(backupRoot, '.staging')
  await fs.mkdir(stagingRoot, { recursive: true })
  const stage = await fs.mkdtemp(path.join(stagingRoot, `${remote.id}-`))

  try {
    const archive = path.join(stage, 'package.zip')
    const extracted = path.join(stage, 'extracted')
    await fs.writeFile(archive, data, { mode: 0o600 })
    await validateZipArchive(archive)
    await fs.mkdir(extracted, { recursive: true })
    await extractZip(archive, { dir: extracted })
    await assertNoLinks(path.resolve(extracted))

    const meta = await inspectSkillArchive(extracted)
    if (meta.name.toLowerCase() !== remote.id.toLowerCase()) {
      throw new Error(`Skill ID 不一致：压缩包是 ${meta.name}，索引是 ${remote.id}`)
    }
    if (compareVersions(meta.version, remote.version) !== 0) {
      throw new Error(`Skill 版本不一致：压缩包是 ${meta.version}，索引是 ${remote.version}`)
    }

    await fs.mkdir(path.dirname(target), { recursive: true })
    const hadPrevious = existsSync(target)
    const backupTarget = hadPrevious
      ? path.join(backupRoot, `${remote.id}-${Date.now()}`)
      : undefined
    if (backupTarget) await fs.mkdir(path.dirname(backupTarget), { recursive: true })

    let oldMoved = false
    try {
      if (backupTarget) {
        await fs.rename(target, backupTarget)
        oldMoved = true
      }
      await fs.rename(meta.root, target)
    } catch (replaceErr) {
      if (oldMoved && backupTarget && !existsSync(target)) {
        await fs.rename(backupTarget, target)
      }
      throw replaceErr
    }

    await fs.access(path.join(target, 'SKILL.md'))
    return {
      ok: true,
      message: previousVersion
        ? `已更新 Skill：${remote.name}（v${previousVersion} → v${remote.version}）`
        : `已安装 Skill：${remote.name}（v${remote.version}）`,
      backupPath: backupTarget
    }
  } finally {
    await removePath(stage)
  }
}
