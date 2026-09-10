import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverPresets } from '@deepseek-ai/dsh-agent-presets'
import { ensurePackagedPresets, packagedPresetRoot } from '../lib/types/dsh-adapter/packaged-presets.js'

const workspace = new URL('..', import.meta.url)
const packagedRoot = join(fileURLToPath(workspace), 'presets')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-tui-presets-'))

try {
  assert.equal(packagedPresetRoot(), packagedRoot)
  const dshHome = join(temporary, 'home')
  assert.deepEqual(ensurePackagedPresets({ dshHome, sourceRoot: packagedRoot }), [])
  assert.deepEqual(ensurePackagedPresets({ dshHome, sourceRoot: packagedRoot }), [])

  const discovered = await discoverPresets([
    { path: join(dshHome, '.agent-presets'), trust: 'user' },
  ], workspace)
  assert.equal(discovered.some(preset => preset.id === 'liangshen'), false)

  const conflictingHome = join(temporary, 'conflicting-home')
  const conflictingPreset = join(conflictingHome, '.agent-presets', 'custom')
  await mkdir(conflictingPreset, { recursive: true })
  await writeFile(join(conflictingPreset, 'keep.txt'), 'user-owned\n')
  assert.deepEqual(ensurePackagedPresets({ dshHome: conflictingHome, sourceRoot: packagedRoot }), [])
  assert.equal(await readFile(join(conflictingPreset, 'keep.txt'), 'utf8'), 'user-owned\n')

  const nextRoot = join(temporary, 'next')
  await cp(packagedRoot, nextRoot, { recursive: true })
  assert.deepEqual(ensurePackagedPresets({ dshHome, sourceRoot: nextRoot }), [])
} finally {
  await rm(temporary, { recursive: true, force: true })
}

console.log('packaged presets OK (empty bundled roster, no Liangshen asset, user preset preservation)')
