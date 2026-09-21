import { existsSync, promises as fs } from 'fs'
import path from 'path'

export interface SkillMaintenanceResult {
  backupPath?: string
  stagingPath?: string
}

function assertBackupRootOutsideSkills(skillsRoot: string, backupRoot: string): void {
  const relative = path.relative(path.resolve(skillsRoot), path.resolve(backupRoot))
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`Skill 备份目录不能位于技能目录内：${backupRoot}`)
  }
}

async function moveDirectory(
  source: string,
  backupRoot: string,
  prefix: string
): Promise<string> {
  const stat = await fs.lstat(source)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Skill 历史目录异常，已跳过：${source}`)
  }

  await fs.mkdir(backupRoot, { recursive: true })
  const target = path.join(backupRoot, `${prefix}-${Date.now()}`)
  await fs.rename(source, target)
  return target
}

export async function migrateLegacySkillWorkDirectories(options: {
  skillsRoot: string
  backupRoot: string
}): Promise<SkillMaintenanceResult> {
  const root = path.resolve(options.skillsRoot)
  const backupRoot = path.resolve(options.backupRoot)
  if (!existsSync(root)) return {}

  assertBackupRootOutsideSkills(root, backupRoot)

  const result: SkillMaintenanceResult = {}
  const legacyBackup = path.join(root, '.dst-backup')
  if (existsSync(legacyBackup)) {
    result.backupPath = await moveDirectory(legacyBackup, backupRoot, 'legacy')
  }

  const legacyStaging = path.join(root, '.dst-staging')
  if (existsSync(legacyStaging)) {
    const stat = await fs.lstat(legacyStaging)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Skill 历史临时目录异常，已跳过：${legacyStaging}`)
    }

    const entries = await fs.readdir(legacyStaging)
    if (!entries.length) {
      await fs.rmdir(legacyStaging)
    } else {
      result.stagingPath = await moveDirectory(
        legacyStaging,
        backupRoot,
        'legacy-staging'
      )
    }
  }

  return result
}
