/**
 * Regression for persisted runtime preferences: a fresh channel must apply
 * the saved effort and permission preset, while a live permission event must
 * update the saved preset for the next fresh session.
 *
 * Run with: node --import tsx/esm scripts/repro-persistent-preferences.tsx
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { sleep } from './lib/term-test.mjs'

const isolatedHome = mkdtempSync(join(tmpdir(), 'dshtui-prefs-home-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome

try {
  const [{ createChannel }, { writeEffortPref }, { readPermissionPref, writePermissionPref }] = await Promise.all([
    import('../src/dsh-adapter/channel.js'),
    import('../src/effortPrefs.js'),
    import('../src/permissionPrefs.js'),
  ])
  const prefsDir = join(isolatedHome, '.dsh-tui')
  writeEffortPref('high', prefsDir)
  writePermissionPref('confirm', prefsDir)

  const root = new Context()
  const llm = new LlmRuntime(root)
  const efforts = [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max' },
  ]
  llm.registerAdapter(['deepseek-official'], {
    providerInfo(provider: string) { return { id: provider, name: 'DeepSeek' } },
    providerRetryPolicy() { return undefined },
    async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, reasoning: { efforts, defaultEffort: 'max' } }
    },
    async *stream(): AsyncGenerator<never> { throw new Error('not exercised') },
  } as never)

  let selectedPermission = 'workspace-write'
  let permissionSetCalls = 0
  const permissionPresets = {
    names: ['workspace-write', 'confirm'],
    current() { return selectedPermission },
    optionOf(name: string) { return { value: name, name } },
    set(session: { events: unknown[] }, name: string) {
      selectedPermission = name
      permissionSetCalls += 1
      session.events.push({ type: 'permission/preset', data: { preset: name } })
    },
  }
  root.provide('permissionPresets', permissionPresets)

  const agentCtx = root.extend()
  const session = { id: 'fresh-session', seq: 0, events: [], header: { id: 'fresh-session', cwd: '/tmp' } }
  const agent = {
    id: 'fresh-session',
    status: 'idle',
    options: {},
    ctx: agentCtx,
    session,
    followup() {},
    steer() {},
    inbox: { remove() {} },
  } as never

  const channel = createChannel(root as never, agent, {
    model: 'deepseek-v4-flash',
    cwd: '/tmp',
    provider: 'deepseek-official',
    activity: false,
    freshSession: true,
  })
  if (selectedPermission !== 'confirm' || permissionSetCalls !== 1) {
    throw new Error(`persisted permission was not applied: ${selectedPermission} (${permissionSetCalls})`)
  }
  if (channel.reasoningEffort !== 'high') {
    throw new Error(`persisted effort was not seeded: ${String(channel.reasoningEffort)}`)
  }

  // Let applyPreferredEffort install the request-selection waterfall, then
  // prove the first fresh request receives the saved level.
  await sleep(50)
  const assembly = { variables: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }
  await (agentCtx as Context).waterfall(
    'system-prompt/assemble' as never,
    assembly,
    {},
    () => Promise.resolve(assembly),
  )
  const proposed = await (agentCtx as Context).waterfall(
    'agent/request' as never,
    { turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
  ) as { reasoningEffort?: string }
  if (proposed.reasoningEffort !== 'high') {
    throw new Error(`persisted effort did not reach request config: ${String(proposed.reasoningEffort)}`)
  }

  // A subsequent user-selected preset is the preference for the next fresh
  // session; this event path is the same path used by /permission.
  const nextEvent = { type: 'permission/preset', data: { preset: 'workspace-write' } }
  session.events.push(nextEvent)
  ;(root as unknown as { emit(name: string, ...args: unknown[]): void }).emit('session/event', session, nextEvent)
  if (readPermissionPref(prefsDir) !== 'workspace-write') {
    throw new Error('live permission selection was not persisted')
  }

  console.log('persistent preferences: effort apply, permission apply, and permission write passed')
} finally {
  rmSync(isolatedHome, { recursive: true, force: true })
}
