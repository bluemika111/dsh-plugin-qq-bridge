#!/usr/bin/env node
/**
 * Installer for dsh-plugin-qq-bridge.
 *
 * WHY THIS EXISTS
 *
 * DSH has a supported install path (`plugin_manager`, i.e. `dsh plugin add`), but that front door
 * refuses the profile this plugin is most often wanted in:
 *
 *     profile "desktop" is managed exclusively by the Electron application
 *
 * The Desktop profile is still an ordinary profile on disk — package.json, pnpm-lock.yaml and
 * node_modules are all there — so the underlying OPERATIONS remain available even though the CLI
 * refuses to perform them. This script does the same two operations directly, which is what makes
 * `npx --yes dsh-plugin-qq-bridge@latest install` possible.
 *
 * WHAT IT DOES
 *
 *   1. Locate the profile directory (~/.dsh/profiles/<name>, or $DSH_HOME/profiles/<name>).
 *   2. Snapshot package.json + pnpm-lock.yaml so a half-applied install can be undone.
 *   3. `pnpm add <this package>@<exact version>` in that directory (pnpm writes node_modules and
 *      records the dependency itself).
 *   4. Verify the INSTALLED manifest declares `dsh.bundle.patch`. Not optional: the harness joins
 *      a dependency to the layer stack only when that field is present, and without it the plugin
 *      is skipped with a warning that is easy to miss. Without this check the install could print
 *      success while the plugin never loads.
 *   5. Add the package name to `dsh.profile.bundles`.
 *   6. Tell the user to restart — the composition is evaluated only at startup.
 *
 * Usage:
 *   npx --yes dsh-plugin-qq-bridge@latest install [--profile <name>] [--dry-run]
 *   npx --yes dsh-plugin-qq-bridge@latest uninstall [--profile <name>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SELF = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
const PACKAGE_NAME = SELF.name
const DESKTOP_PROFILE = 'desktop'
const PNPM_DEFAULT_MAJOR = '11'

const write = (line) => process.stdout.write(line + '\n')

function fail(message, code) {
  process.stderr.write('\n' + PACKAGE_NAME + ': ' + message + '\n')
  process.exit(code === undefined ? 1 : code)
}

/** An expected failure raised after the snapshot, so the caller can roll back before exiting. */
class CliError extends Error {}

/* ------------------------------------------------------------------ arguments */

function parseArgs(argv) {
  const options = { command: 'install', profile: DESKTOP_PROFILE, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === 'install' || arg === 'uninstall') {
      options.command = arg
      continue
    }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--profile') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) fail('--profile 需要一个 profile 名称')
      options.profile = value
      i += 1
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.command = 'help'
      continue
    }
    fail('未知参数：' + arg + '（试试 --help）')
  }
  return options
}

function help() {
  write(
    [
      PACKAGE_NAME + ' ' + SELF.version,
      '',
      '用法：',
      '  npx --yes ' + PACKAGE_NAME + '@latest install   [--profile <name>] [--dry-run]',
      '  npx --yes ' + PACKAGE_NAME + '@latest uninstall [--profile <name>]',
      '',
      '选项：',
      '  --profile <name>   装进哪个 profile（默认 ' + DESKTOP_PROFILE + '）',
      '  --dry-run          只打印将要做什么，不改动任何文件',
      '',
      '装完需要重启 DSH：插件组合只在启动时求值。',
    ].join('\n'),
  )
}

/* ------------------------------------------------------------------ profile location */

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

const profileDir = (profile) => path.join(dshHome(), 'profiles', profile)
const readManifest = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/* ------------------------------------------------------------------ atomic write + rollback */

function makeRollback() {
  const snapshots = []
  return {
    capture(file) {
      if (!fs.existsSync(file)) {
        snapshots.push({ file, existed: false, bytes: null })
        return
      }
      snapshots.push({ file, existed: true, bytes: fs.readFileSync(file) })
    },
    restore() {
      for (const snapshot of snapshots) {
        try {
          if (snapshot.existed) fs.writeFileSync(snapshot.file, snapshot.bytes)
          else if (fs.existsSync(snapshot.file)) fs.unlinkSync(snapshot.file)
        } catch (error) {
          process.stderr.write(PACKAGE_NAME + ': 无法还原 ' + snapshot.file + ': ' + String(error) + '\n')
        }
      }
    },
  }
}

function writeAtomic(file, text) {
  const temporary = file + '.' + PACKAGE_NAME + '.tmp'
  fs.writeFileSync(temporary, text)
  fs.renameSync(temporary, file)
}

/* ------------------------------------------------------------------ package manager */

/**
 * Which pnpm major the profile was installed with.
 *
 * This is not cosmetic. pnpm keeps one store per major (`store/v11`, `store/v10`, …), and mixing
 * them fails hard:
 *
 *     ERR_PNPM_UNEXPECTED_STORE  The dependencies are currently linked from the store at
 *     ...\store\v11, pnpm now wants to use the store at ...\store\v10
 *
 * `.modules.yaml` is written by pnpm at install time and records both the exact package manager
 * and the store it linked from, so it is the reliable source. A fresh profile has no such file —
 * then any reasonably current pnpm is fine.
 */
function profilePnpmMajor(profilePath) {
  const file = path.join(profilePath, 'node_modules', '.modules.yaml')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const byPackageManager = /packageManager:\s*"?pnpm@(\d+)\./.exec(text)
  if (byPackageManager !== null) return byPackageManager[1]
  const byStore = /storeDir:.*?[\\/]v(\d+)/.exec(text)
  return byStore === null ? undefined : byStore[1]
}

/**
 * Run pnpm here.
 *
 * `shell: true` is required on Windows — pnpm is a `.cmd` shim, and Node refuses to execute one
 * without a shell (the CVE-2024-27980 mitigation). The cost is that Node concatenates arguments
 * instead of quoting them, so any spec containing a space would be re-split by the shell; the only
 * such spec is a local directory path, and `install()` refuses that before reaching here.
 *
 * pnpm is not always on PATH (DSH Desktop bundles its own), and the copy on PATH can be a
 * different major than the one that built this profile. Either case is handled by running the
 * requested major through npx, so the store always matches.
 */
function runPnpm(cwd, args, wantedMajor) {
  const probe = spawnSync('pnpm --version', { shell: true, windowsHide: true, encoding: 'utf8' })
  const haveVersion = probe.status === 0 && typeof probe.stdout === 'string' ? probe.stdout.trim() : ''
  const haveMajor = /^(\d+)\./.exec(haveVersion)
  const wanted = wantedMajor === undefined ? PNPM_DEFAULT_MAJOR : wantedMajor
  const usable = haveMajor !== null && (wantedMajor === undefined || haveMajor[1] === wantedMajor)

  const parts = usable ? ['pnpm'] : ['npx', '--yes', 'pnpm@' + wanted]
  if (!usable) {
    write(
      haveVersion === ''
        ? '  pnpm 不在 PATH 上，改用 npx pnpm@' + wanted
        : '  PATH 上的 pnpm ' + haveVersion + ' 与 profile 使用的 pnpm@' + wanted
            + ' 不同（store 会冲突），改用 npx pnpm@' + wanted,
    )
  }

  // One command string rather than an argument array: with `shell: true` Node only concatenates
  // arguments, and warns about it (DEP0190). Every part is space-free by construction — the spec
  // is either `<name>@<version>` or rejected by the guard in install() — so joining is safe and
  // the install output stays clean.
  const result = spawnSync(parts.concat(args).join(' '), {
    cwd,
    stdio: 'inherit',
    shell: true,
    windowsHide: true,
  })
  if (result.error !== undefined) {
    if (result.error.code === 'ENOENT') {
      fail('找不到 ' + command + '。请确认 Node.js 与 npm 已安装并在 PATH 上。')
    }
    fail('无法执行 ' + command + ': ' + String(result.error))
  }
  return result.status === null ? 1 : result.status
}

/* ------------------------------------------------------------------ operations */

/** The spec handed to pnpm: exact version from npm, or the local directory during development. */
function installSpec() {
  const inNodeModules = HERE.split(path.sep).indexOf('node_modules') !== -1
  if (inNodeModules) return PACKAGE_NAME + '@' + SELF.version
  return path.resolve(HERE, '..')
}

const installedManifestPath = (profilePath) =>
  path.join(profilePath, 'node_modules', ...PACKAGE_NAME.split('/'), 'package.json')

function assertBundleDeclaration(profilePath) {
  const manifestPath = installedManifestPath(profilePath)
  if (!fs.existsSync(manifestPath)) {
    throw new CliError('pnpm 报告成功，但 ' + manifestPath + ' 不存在——包实际上没有装上。')
  }
  let manifest
  try {
    manifest = readManifest(manifestPath)
  } catch (error) {
    throw new CliError('已安装的 package.json 无法解析：' + String(error))
  }
  const patch = manifest.dsh && manifest.dsh.bundle ? manifest.dsh.bundle.patch : undefined
  if (patch === undefined) {
    throw new CliError('已安装的包没有声明 `dsh.bundle.patch`，harness 会把它当成普通库、永远不会加载。'
      + '发布版本不可能出现这种情况，装上的副本可能已损坏。')
  }
  return patch
}

function addToBundles(profilePath, rollback) {
  const manifestPath = path.join(profilePath, 'package.json')
  const manifest = readManifest(manifestPath)
  const dsh = manifest.dsh === undefined ? {} : manifest.dsh
  const profileSection = dsh.profile === undefined ? {} : dsh.profile
  const bundles = Array.isArray(profileSection.bundles) ? profileSection.bundles.slice() : []

  if (bundles.indexOf(PACKAGE_NAME) !== -1) {
    write('  已经在 dsh.profile.bundles 里了')
    return false
  }

  bundles.push(PACKAGE_NAME)
  manifest.dsh = Object.assign({}, dsh, {
    profile: Object.assign({}, profileSection, { bundles }),
  })

  // Captured immediately before the write: a snapshot taken earlier would restore a version that
  // predates any other change made in between.
  rollback.capture(manifestPath)
  writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  write('  已加入 dsh.profile.bundles')
  return true
}

function removeFromBundles(profilePath, rollback) {
  const manifestPath = path.join(profilePath, 'package.json')
  const manifest = readManifest(manifestPath)
  const bundles =
    manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)
      ? manifest.dsh.profile.bundles
      : []
  const at = bundles.indexOf(PACKAGE_NAME)
  if (at === -1) {
    write('  不在 dsh.profile.bundles 里')
    return false
  }
  bundles.splice(at, 1)
  rollback.capture(manifestPath)
  writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  write('  已从 dsh.profile.bundles 移除')
  return true
}

function preflight(profilePath) {
  if (!fs.existsSync(profilePath)) {
    fail('找不到 profile 目录：' + profilePath
      + '\n  先用该 profile 启动一次 DSH，或用 --profile <name> 指定。')
  }
  if (!fs.existsSync(path.join(profilePath, 'package.json'))) {
    fail(profilePath + ' 里没有 package.json，这不像一个初始化过的 profile。'
      + '\n  先用该 profile 启动一次 DSH。')
  }
}

/* ------------------------------------------------------------------ commands */

function install(options) {
  const profilePath = profileDir(options.profile)
  write(PACKAGE_NAME + ' ' + SELF.version + ' -> profile "' + options.profile + '"')
  write('  profile 目录: [' + profilePath + ']')
  preflight(profilePath)

  const manifestPath = path.join(profilePath, 'package.json')
  const lockPath = path.join(profilePath, 'pnpm-lock.yaml')
  const alreadyInstalled = fs.existsSync(installedManifestPath(profilePath))
  const spec = installSpec()

  if (options.dryRun) {
    write('  --dry-run：将在此目录执行 pnpm add ' + spec)
    write('  --dry-run：并确保 ' + PACKAGE_NAME + ' 出现在 dsh.profile.bundles')
    return
  }

  // Only the local-directory path can contain a space, and a spacey spec is silently split into
  // several bogus dependencies by the shell. Failing loudly beats a success that installed the
  // wrong thing.
  if (spec.indexOf(' ') !== -1) {
    fail('拒绝从含空格的路径安装：\n  ' + spec
      + '\n  pnpm 经由 shell 调用，带空格的路径会被拆成多个依赖。'
      + '\n  把包复制到无空格目录再从那里运行，或直接从 npm 安装（用包名，不含空格）。')
  }

  const rollback = makeRollback()
  rollback.capture(manifestPath)
  rollback.capture(lockPath)

  const wantedPnpm = profilePnpmMajor(profilePath)
  write(alreadyInstalled ? '  包已存在，刷新到 ' + SELF.version : '  正在安装...')
  const status = runPnpm(profilePath, ['add', spec, '--config.minimumReleaseAge=0'], wantedPnpm)
  if (status !== 0) {
    rollback.restore()
    fail('pnpm 退出码 ' + status + '。profile 文件已还原，什么都没变。')
  }

  try {
    const patch = assertBundleDeclaration(profilePath)
    write('  已安装的包声明 dsh.bundle.patch -> ' + patch)
    addToBundles(profilePath, rollback)
  } catch (error) {
    rollback.restore()
    const message = error instanceof CliError ? error.message : String(error && error.message ? error.message : error)
    fail(message + '\n\nprofile 文件已还原（package.json 与 pnpm-lock.yaml），与命令执行前一致。')
  }

  write('')
  write('安装完成。请重启 DSH —— 插件组合只在启动时求值，重启前不会出现在界面上。')
  write('')
  write('重启后：每条会话输入框下方会多出一行 `QQ …`，点它可以配置连接与关联联系人。')
  write('首次使用还需要两步：在协议端开一条正向 WebSocket，并把地址填进面板。')
}

function uninstall(options) {
  const profilePath = profileDir(options.profile)
  write(PACKAGE_NAME + ' <- profile "' + options.profile + '"')
  write('  profile 目录: [' + profilePath + ']')
  preflight(profilePath)

  if (options.dryRun) {
    write('  --dry-run：将从 dsh.profile.bundles 移除，并执行 pnpm remove')
    return
  }

  const rollback = makeRollback()
  try {
    // Remove from the layer list FIRST: leaving the row while the package is gone would make the
    // next boot fail to resolve it.
    removeFromBundles(profilePath, rollback)
  } catch (error) {
    rollback.restore()
    fail('无法更新 dsh.profile.bundles：' + String(error))
  }

  const status = runPnpm(profilePath, ['remove', PACKAGE_NAME], profilePnpmMajor(profilePath))
  if (status !== 0) {
    write('  注意：pnpm remove 退出码 ' + status + '，包可能还在，但已不在 dsh.profile.bundles 里，不会再加载。')
  }

  write('')
  write('已移除。重启 DSH 生效。')
  write('')
  write('你的连接配置与聊天关联保存在 ~/.dsh/qq-bridge/，重装后会继续沿用；')
  write('要彻底清空就删掉那个目录。')
}

/* ------------------------------------------------------------------ entry */

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'help') {
    help()
    return
  }
  if (options.command === 'install') {
    install(options)
    return
  }
  uninstall(options)
}

main()
