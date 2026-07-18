import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  CapabilityRegistry,
  CapabilityRegistryError,
  type CapabilityWorkspaceIdentity
} from '../../src/main/services/capability-registry.ts'

const OWNER_A = 17
const OWNER_B = 29

async function createTempRoot(t: TestContext, prefix: string): Promise<string> {
  const root = await fs.mkdtemp(join(process.env.TEMP ?? process.cwd(), prefix))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

async function workspaceIdentity(absolutePath: string): Promise<CapabilityWorkspaceIdentity> {
  const stats = await fs.lstat(absolutePath, { bigint: true })
  assert.equal(stats.isDirectory(), true)
  const device = String(stats.dev)
  const inode = String(stats.ino)
  assert.notEqual(device, '0')
  assert.notEqual(inode, '0')
  return { absolutePath, device, inode }
}

function mismatchedWorkspace(
  workspace: CapabilityWorkspaceIdentity
): CapabilityWorkspaceIdentity {
  return {
    ...workspace,
    inode: String(BigInt(workspace.inode) + 1n)
  }
}

test('capability discovery is opt-in and the default list never reads local directories', async (t) => {
  const root = await createTempRoot(t, 'ai-terminal-capability-consent-')
  const home = join(root, 'home')
  await fs.mkdir(join(home, '.codex', 'skills', 'private-skill'), { recursive: true })
  await fs.writeFile(join(home, '.codex', 'skills', 'private-skill', 'SKILL.md'), '# Private\n', 'utf8')

  const registry = new CapabilityRegistry({ homeDirectory: home })
  const withoutConsent = await registry.list({ ownerWebContentsId: OWNER_A })
  assert.deepEqual(withoutConsent.skills, [])
  assert.deepEqual(withoutConsent.plugins, [])
  assert.deepEqual(withoutConsent.session, { planMode: false, memoriesEnabled: true })

  const withConsent = await registry.list({
    ownerWebContentsId: OWNER_A,
    discover: 'skills'
  })
  assert.equal(withConsent.skills.some((skill) => skill.name === 'private-skill'), true)
  assert.deepEqual(withConsent.plugins, [])
})

test('skill and plugin discovery are category-isolated and expose metadata only', async (t) => {
  const root = await createTempRoot(t, 'ai-terminal-capabilities-')
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await fs.mkdir(join(home, '.codex', 'skills', 'summarize'), { recursive: true })
  await fs.mkdir(join(home, '.codex-plugin'), { recursive: true })
  await fs.mkdir(join(workspace, '.agents', 'skills', 'review-helper'), { recursive: true })
  await fs.mkdir(join(workspace, '.codex-plugin'), { recursive: true })
  await fs.writeFile(
    join(home, '.codex', 'skills', 'summarize', 'SKILL.md'),
    '---\nname: Summarize\ndescription: Summarize approved text\nallowed-tools: read\n---\n\nprivate body must not cross the boundary\n',
    'utf8'
  )
  await fs.writeFile(
    join(workspace, '.agents', 'skills', 'review-helper', 'SKILL.md'),
    '# Review helper\nReview a workspace diff\n',
    'utf8'
  )
  await fs.writeFile(
    join(workspace, '.codex-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'local-review',
      description: 'Review integration',
      version: '1.2.3',
      permissions: ['read', 'execute'],
      commands: { review: {} },
      scripts: { start: 'node private-script.js' }
    }),
    'utf8'
  )
  await fs.writeFile(
    join(home, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'script-only', scripts: { start: 'node private.js' } }),
    'utf8'
  )

  const registry = new CapabilityRegistry({ homeDirectory: home })
  const identity = await workspaceIdentity(workspace)
  const skillCatalog = await registry.list({
    ownerWebContentsId: OWNER_A,
    discover: 'skills',
    workspace: identity
  })
  const pluginCatalog = await registry.list({
    ownerWebContentsId: OWNER_A,
    discover: 'plugins',
    workspace: identity
  })

  assert.deepEqual(
    skillCatalog.commands.map((command) => command.id),
    ['plan', 'goal', 'compact', 'memories', 'init', 'review', 'status']
  )
  assert.equal(
    skillCatalog.skills.some((skill) => skill.name === 'Summarize' && skill.scope === 'user'),
    true
  )
  assert.equal(
    skillCatalog.skills.some((skill) => skill.name === 'review-helper' && skill.scope === 'workspace'),
    true
  )
  assert.deepEqual(skillCatalog.plugins, [])
  assert.deepEqual(pluginCatalog.skills, [])
  assert.equal(pluginCatalog.plugins.some((plugin) => plugin.name === 'local-review'), true)
  assert.equal(pluginCatalog.plugins.every((plugin) => plugin.enabled === false), true)

  const localReview = pluginCatalog.plugins.find((plugin) => plugin.name === 'local-review')
  assert.ok(localReview)
  assert.equal(localReview.permissions.includes('execute'), true)
  assert.equal(localReview.permissions.includes('approval'), true)
  const scriptOnly = pluginCatalog.plugins.find((plugin) => plugin.name === 'script-only')
  assert.ok(scriptOnly)
  assert.equal(scriptOnly.permissions.includes('execute'), true)
  assert.equal(scriptOnly.permissions.includes('approval'), true)

  const serialized = JSON.stringify({ skillCatalog, pluginCatalog })
  assert.equal(serialized.includes(home), false)
  assert.equal(serialized.includes(workspace), false)
  assert.equal(serialized.includes('private body'), false)
  assert.equal(serialized.includes('private-script.js'), false)
  for (const item of [...skillCatalog.skills, ...pluginCatalog.plugins]) {
    assert.match(item.grantHandle, /^cap_[A-Za-z0-9_-]{43}$/u)
    assert.equal(item.relativePath.includes('..'), false)
    assert.equal(item.relativePath.startsWith('/'), false)
  }
})

test('safe capability commands only change owner-bound in-memory state', async () => {
  const registry = new CapabilityRegistry({ homeDirectory: process.cwd() })

  const plan = await registry.execute({
    id: '/plan',
    args: 'inspect files; run tests',
    ownerWebContentsId: OWNER_A
  })
  assert.equal(plan.status, 'completed')
  assert.deepEqual(plan.plan, ['inspect files', 'run tests'])

  const goal = await registry.execute({
    id: 'goal',
    args: 'Ship the reviewed change',
    ownerWebContentsId: OWNER_A
  })
  assert.deepEqual(goal.goal, { text: 'Ship the reviewed change', status: 'active' })
  const paused = await registry.execute({
    id: 'goal',
    args: 'pause',
    ownerWebContentsId: OWNER_A
  })
  assert.equal(paused.goal?.status, 'paused')
  const resumed = await registry.execute({
    id: 'goal',
    args: 'resume',
    ownerWebContentsId: OWNER_A
  })
  assert.equal(resumed.goal?.status, 'active')

  const memories = await registry.execute({
    id: 'memories',
    args: 'off',
    ownerWebContentsId: OWNER_A
  })
  assert.match(memories.message, /disabled/u)
  const status = await registry.execute({ id: 'status', ownerWebContentsId: OWNER_A })
  assert.equal(status.status, 'completed')
  assert.match(status.message, /mode=plan/u)
  assert.match(status.message, /memories=off/u)

  const init = await registry.execute({ id: 'init', ownerWebContentsId: OWNER_A })
  assert.equal(init.status, 'requires-approval')
  const review = await registry.execute({ id: 'review', ownerWebContentsId: OWNER_A })
  assert.equal(review.status, 'not-ready')
  await registry.execute({ id: 'plan', args: 'off', ownerWebContentsId: OWNER_A })
  const reviewWithoutWorkspace = await registry.execute({ id: 'review', ownerWebContentsId: OWNER_A })
  assert.equal(reviewWithoutWorkspace.status, 'not-ready')
  const plugin = await registry.execute({
    id: 'plugin:workspace:local-review',
    ownerWebContentsId: OWNER_A
  })
  assert.equal(plugin.status, 'not-ready')
})

test('review intent is one-shot, owner-bound, workspace-bound, and cleared by plan mode', async (t) => {
  const root = await createTempRoot(t, 'ai-terminal-review-intent-')
  const home = join(root, 'home')
  const firstWorkspacePath = join(root, 'workspace-a')
  const secondWorkspacePath = join(root, 'workspace-b')
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(firstWorkspacePath, { recursive: true })
  await fs.mkdir(secondWorkspacePath, { recursive: true })
  const firstWorkspace = await workspaceIdentity(firstWorkspacePath)
  const secondWorkspace = await workspaceIdentity(secondWorkspacePath)
  const registry = new CapabilityRegistry({ homeDirectory: home })

  const armed = await registry.execute({
    id: 'review',
    ownerWebContentsId: OWNER_A,
    workspace: firstWorkspace
  })
  assert.equal(armed.status, 'preview')
  assert.match(armed.reviewHandle ?? '', /^review_[A-Za-z0-9_-]{43}$/u)
  assert.equal(registry.consumeReviewMode(OWNER_B, firstWorkspace, armed.reviewHandle), false)
  assert.equal(registry.consumeReviewMode(OWNER_A, firstWorkspace, `review_${'x'.repeat(43)}`), false)
  assert.equal(registry.consumeReviewMode(OWNER_A, secondWorkspace, armed.reviewHandle), false)
  assert.equal(registry.consumeReviewMode(OWNER_A, firstWorkspace, armed.reviewHandle), false)

  const rearmed = await registry.execute({ id: 'review', ownerWebContentsId: OWNER_A, workspace: firstWorkspace })
  assert.equal(registry.consumeReviewMode(OWNER_A, firstWorkspace, rearmed.reviewHandle), true)
  assert.equal(registry.consumeReviewMode(OWNER_A, firstWorkspace, rearmed.reviewHandle), false)

  const cleared = await registry.execute({ id: 'review', ownerWebContentsId: OWNER_A, workspace: firstWorkspace })
  await registry.execute({ id: 'plan', args: 'inspect only', ownerWebContentsId: OWNER_A })
  assert.equal(registry.consumeReviewMode(OWNER_A, firstWorkspace, cleared.reviewHandle), false)
})

test('session state is isolated by renderer owner', async () => {
  const registry = new CapabilityRegistry({ homeDirectory: process.cwd() })
  await registry.execute({ id: 'plan', args: 'owner A plan', ownerWebContentsId: OWNER_A })
  await registry.execute({ id: 'goal', args: 'Owner A goal', ownerWebContentsId: OWNER_A })
  await registry.execute({ id: 'memories', args: 'off', ownerWebContentsId: OWNER_A })

  const ownerB = await registry.list({ ownerWebContentsId: OWNER_B })
  assert.deepEqual(ownerB.session, { planMode: false, memoriesEnabled: true })
  assert.equal(registry.getPlanMode(OWNER_B), false)

  await registry.execute({ id: 'goal', args: 'Owner B goal', ownerWebContentsId: OWNER_B })
  const ownerAStatus = await registry.execute({ id: 'status', ownerWebContentsId: OWNER_A })
  const ownerBStatus = await registry.execute({ id: 'status', ownerWebContentsId: OWNER_B })
  assert.deepEqual(ownerAStatus.session, {
    planMode: true,
    memoriesEnabled: false,
    goal: { text: 'Owner A goal', status: 'active' }
  })
  assert.deepEqual(ownerBStatus.session, {
    planMode: false,
    memoriesEnabled: true,
    goal: { text: 'Owner B goal', status: 'active' }
  })
})

test('loads an approved skill body with redaction, a hard bound, and a one-shot grant', async (t) => {
  const root = await createTempRoot(t, 'ai-terminal-skill-execute-')
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await fs.mkdir(join(workspace, '.codex', 'skills', 'safe-skill'), { recursive: true })
  const body = [
    '---',
    'name: Safe skill',
    'description: Bounded instructions',
    '---',
    '',
    'Use the approved read tool only.',
    'api_key=not-a-real-secret-value',
    'C:\\private\\workspace\\file.txt',
    'x'.repeat(20_000)
  ].join('\n')
  await fs.writeFile(join(workspace, '.codex', 'skills', 'safe-skill', 'SKILL.md'), body, 'utf8')

  const registry = new CapabilityRegistry({ homeDirectory: home })
  const identity = await workspaceIdentity(workspace)
  const catalog = await registry.list({
    ownerWebContentsId: OWNER_A,
    discover: 'skills',
    workspace: identity
  })
  const skill = catalog.skills.find((item) => item.scope === 'workspace')
  assert.ok(skill)

  const pending = await registry.execute({
    id: skill.id,
    ownerWebContentsId: OWNER_A,
    workspace: identity
  })
  assert.equal(pending.status, 'requires-approval')
  assert.equal(pending.instructions, undefined)

  let approvalRequests = 0
  const result = await registry.execute({
    id: skill.id,
    ownerWebContentsId: OWNER_A,
    workspace: identity,
    grantHandle: skill.grantHandle,
    authorizeSkillUse: async (request) => {
      approvalRequests += 1
      assert.deepEqual(request, {
        id: skill.id,
        scope: 'workspace',
        relativePath: skill.relativePath
      })
      return true
    }
  })
  assert.equal(approvalRequests, 1)
  assert.equal(result.status, 'completed')
  assert.ok(result.instructions)
  assert.equal(Buffer.byteLength(result.instructions, 'utf8') <= 12 * 1024, true)
  assert.equal(result.instructions.includes('name: Safe skill'), false)
  assert.equal(result.instructions.includes('not-a-real-secret-value'), false)
  assert.equal(result.instructions.includes('C:\\private'), false)
  assert.equal(result.instructions.includes(workspace), false)
  assert.match(result.instructions, /approved read tool/u)

  const replay = await registry.execute({
    id: skill.id,
    ownerWebContentsId: OWNER_A,
    workspace: identity,
    grantHandle: skill.grantHandle,
    authorizeSkillUse: async () => {
      approvalRequests += 1
      return true
    }
  })
  assert.equal(replay.status, 'not-ready')
  assert.equal(replay.instructions, undefined)
  assert.equal(approvalRequests, 1)
})

test('denied skill approval burns the grant without reading the skill file', async (t) => {
  const root = await createTempRoot(t, 'ai-terminal-skill-denied-')
  const home = join(root, 'home')
  const skillDirectory = join(home, '.codex', 'skills', 'approval-required')
  await fs.mkdir(skillDirectory, { recursive: true })
  await fs.writeFile(join(skillDirectory, 'SKILL.md'), '# Approval required\nDo not read before approval.\n', 'utf8')

  const registry = new CapabilityRegistry({ homeDirectory: home })
  const catalog = await registry.list({ ownerWebContentsId: OWNER_A, discover: 'skills' })
  const skill = catalog.skills[0]
  assert.ok(skill)

  const originalOpenDescriptor = Object.getOwnPropertyDescriptor(fs, 'open')
  assert.ok(originalOpenDescriptor)
  let openAttempts = 0
  Object.defineProperty(fs, 'open', {
    ...originalOpenDescriptor,
    value: (() => {
      openAttempts += 1
      throw new Error('skill file must not be opened after approval denial')
    }) as typeof fs.open
  })
  let denied
  try {
    denied = await registry.execute({
      id: skill.id,
      ownerWebContentsId: OWNER_A,
      grantHandle: skill.grantHandle,
      authorizeSkillUse: async () => false
    })
  } finally {
    Object.defineProperty(fs, 'open', originalOpenDescriptor)
  }

  assert.equal(denied.status, 'requires-approval')
  assert.equal(denied.instructions, undefined)
  assert.equal(openAttempts, 0)

  let replayApprovalCalls = 0
  const replay = await registry.execute({
    id: skill.id,
    ownerWebContentsId: OWNER_A,
    grantHandle: skill.grantHandle,
    authorizeSkillUse: async () => {
      replayApprovalCalls += 1
      return true
    }
  })
  assert.equal(replay.status, 'not-ready')
  assert.equal(replayApprovalCalls, 0)
})

test('same-metadata skill content substitution fails until rediscovery', async (t) => {
  const root = await createTempRoot(t, 'ai-terminal-skill-digest-')
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const skillDirectory = join(workspace, '.agents', 'skills', 'digest-bound')
  const skillPath = join(skillDirectory, 'SKILL.md')
  const original = '# Digest bound\nUse alpha content only.\n'
  const substituted = '# Digest bound\nUse omega content only.\n'
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(substituted))
  await fs.mkdir(skillDirectory, { recursive: true })
  await fs.writeFile(skillPath, original, 'utf8')
  const fixedTimestampSeconds = 1_700_000_000
  await fs.utimes(skillPath, fixedTimestampSeconds, fixedTimestampSeconds)

  const registry = new CapabilityRegistry({ homeDirectory: home })
  const identity = await workspaceIdentity(workspace)
  const catalog = await registry.list({
    ownerWebContentsId: OWNER_A,
    discover: 'skills',
    workspace: identity
  })
  const skill = catalog.skills.find((item) => item.scope === 'workspace')
  assert.ok(skill)
  const before = await fs.lstat(skillPath, { bigint: true })

  await fs.writeFile(skillPath, substituted, 'utf8')
  await fs.utimes(skillPath, fixedTimestampSeconds, fixedTimestampSeconds)
  const after = await fs.lstat(skillPath, { bigint: true })
  assert.equal(String(after.dev), String(before.dev))
  assert.equal(String(after.ino), String(before.ino))
  assert.equal(after.size, before.size)
  assert.equal(after.mtimeMs, before.mtimeMs)

  const changed = await registry.execute({
    id: skill.id,
    ownerWebContentsId: OWNER_A,
    workspace: identity,
    grantHandle: skill.grantHandle,
    authorizeSkillUse: async () => true
  })
  assert.equal(changed.status, 'not-ready')
  assert.equal(changed.instructions, undefined)
  assert.match(changed.message, /changed after discovery/u)

  const staleRetry = await registry.execute({
    id: skill.id,
    ownerWebContentsId: OWNER_A,
    workspace: identity,
    grantHandle: skill.grantHandle,
    authorizeSkillUse: async () => true
  })
  assert.equal(staleRetry.status, 'not-ready')

  const rediscovered = await registry.list({
    ownerWebContentsId: OWNER_A,
    discover: 'skills',
    workspace: identity
  })
  const refreshedSkill = rediscovered.skills.find((item) => item.scope === 'workspace')
  assert.ok(refreshedSkill)
  assert.notEqual(refreshedSkill.grantHandle, skill.grantHandle)
  const refreshed = await registry.execute({
    id: refreshedSkill.id,
    ownerWebContentsId: OWNER_A,
    workspace: identity,
    grantHandle: refreshedSkill.grantHandle,
    authorizeSkillUse: async () => true
  })
  assert.equal(refreshed.status, 'completed')
  assert.match(refreshed.instructions ?? '', /omega content/u)
})

test('wrong workspace identity rejects discovery and burns a workspace skill grant', async (t) => {
  const root = await createTempRoot(t, 'ai-terminal-capability-identity-')
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await fs.mkdir(join(workspace, '.agents', 'skills', 'identity-bound'), { recursive: true })
  await fs.writeFile(
    join(workspace, '.agents', 'skills', 'identity-bound', 'SKILL.md'),
    '# Identity bound\n',
    'utf8'
  )

  const registry = new CapabilityRegistry({ homeDirectory: home })
  const identity = await workspaceIdentity(workspace)
  const wrongIdentity = mismatchedWorkspace(identity)
  await assert.rejects(
    registry.list({
      ownerWebContentsId: OWNER_A,
      discover: 'skills',
      workspace: wrongIdentity
    }),
    (error: unknown) => error instanceof CapabilityRegistryError && error.code === 'storage_error'
  )

  const catalog = await registry.list({
    ownerWebContentsId: OWNER_A,
    discover: 'skills',
    workspace: identity
  })
  const skill = catalog.skills.find((item) => item.scope === 'workspace')
  assert.ok(skill)
  let approvalCalls = 0
  const wrongUse = await registry.execute({
    id: skill.id,
    ownerWebContentsId: OWNER_A,
    workspace: wrongIdentity,
    grantHandle: skill.grantHandle,
    authorizeSkillUse: async () => {
      approvalCalls += 1
      return true
    }
  })
  assert.equal(wrongUse.status, 'not-ready')
  assert.equal(wrongUse.instructions, undefined)
  assert.equal(approvalCalls, 0)

  const retry = await registry.execute({
    id: skill.id,
    ownerWebContentsId: OWNER_A,
    workspace: identity,
    grantHandle: skill.grantHandle,
    authorizeSkillUse: async () => {
      approvalCalls += 1
      return true
    }
  })
  assert.equal(retry.status, 'not-ready')
  assert.equal(approvalCalls, 0)
})

test('resetOwner clears plan, goal, memory state, and outstanding grants', async (t) => {
  const root = await createTempRoot(t, 'ai-terminal-capability-reset-')
  const home = join(root, 'home')
  await fs.mkdir(join(home, '.agents', 'skills', 'reset-bound'), { recursive: true })
  await fs.writeFile(
    join(home, '.agents', 'skills', 'reset-bound', 'SKILL.md'),
    '# Reset bound\n',
    'utf8'
  )
  const registry = new CapabilityRegistry({ homeDirectory: home })
  await registry.execute({ id: 'plan', args: 'one step', ownerWebContentsId: OWNER_A })
  await registry.execute({ id: 'goal', args: 'Reset me', ownerWebContentsId: OWNER_A })
  await registry.execute({ id: 'memories', args: 'off', ownerWebContentsId: OWNER_A })
  const catalog = await registry.list({ ownerWebContentsId: OWNER_A, discover: 'skills' })
  const skill = catalog.skills[0]
  assert.ok(skill)

  registry.resetOwner(OWNER_A)
  assert.equal(registry.getPlanMode(OWNER_A), false)
  const resetCatalog = await registry.list({ ownerWebContentsId: OWNER_A })
  assert.deepEqual(resetCatalog.session, { planMode: false, memoriesEnabled: true })

  let approvalCalls = 0
  const revoked = await registry.execute({
    id: skill.id,
    ownerWebContentsId: OWNER_A,
    grantHandle: skill.grantHandle,
    authorizeSkillUse: async () => {
      approvalCalls += 1
      return true
    }
  })
  assert.equal(revoked.status, 'not-ready')
  assert.equal(approvalCalls, 0)
})

test('invalid capability arguments and path-only workspace fallbacks fail closed', async (t) => {
  const root = await createTempRoot(t, 'ai-terminal-capability-invalid-')
  const workspace = join(root, 'workspace')
  await fs.mkdir(workspace)

  assert.throws(
    () => new CapabilityRegistry({ homeDirectory: process.cwd(), unexpected: true } as never),
    (error: unknown) => error instanceof CapabilityRegistryError && error.code === 'invalid_input'
  )
  const registry = new CapabilityRegistry({ homeDirectory: process.cwd() })
  await assert.rejects(
    registry.list({
      ownerWebContentsId: OWNER_A,
      discover: 'skills',
      workspaceRoot: workspace
    } as never),
    (error: unknown) => error instanceof CapabilityRegistryError && error.code === 'invalid_input'
  )
  await assert.rejects(
    registry.list({
      ownerWebContentsId: OWNER_A,
      discover: 'skills',
      workspace: { absolutePath: workspace }
    } as never),
    (error: unknown) => error instanceof CapabilityRegistryError && error.code === 'invalid_input'
  )
  await assert.rejects(
    registry.execute({
      id: 'review',
      ownerWebContentsId: OWNER_A,
      workspaceRoot: workspace
    } as never),
    (error: unknown) => error instanceof CapabilityRegistryError && error.code === 'invalid_input'
  )
  await assert.rejects(
    registry.execute({
      id: 'status',
      args: 'x'.repeat(2_001),
      ownerWebContentsId: OWNER_A
    }),
    (error: unknown) => error instanceof CapabilityRegistryError && error.code === 'invalid_input'
  )
  await assert.rejects(
    registry.list({ ownerWebContentsId: 0 }),
    (error: unknown) => error instanceof CapabilityRegistryError && error.code === 'invalid_input'
  )
})

test('symlinked skill/plugin parents are ignored even when the final file is regular', async (t) => {
  const root = await createTempRoot(t, 'ai-terminal-capability-links-')
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  await fs.mkdir(join(workspace, '.agents'), { recursive: true })
  await fs.mkdir(join(outside, 'skills', 'escaped'), { recursive: true })
  await fs.writeFile(join(outside, 'skills', 'escaped', 'SKILL.md'), '# Escaped\n', 'utf8')
  try {
    await fs.symlink(join(outside, 'skills'), join(workspace, '.agents', 'skills'), 'junction')
  } catch {
    // Creating links may require elevated privileges on Windows; the rest of
    // the suite still covers the path checks on platforms that support it.
    t.skip('symbolic links are unavailable in this test environment')
    return
  }

  const registry = new CapabilityRegistry({ homeDirectory: home })
  const identity = await workspaceIdentity(workspace)
  const catalog = await registry.list({
    ownerWebContentsId: OWNER_A,
    discover: 'skills',
    workspace: identity
  })
  assert.equal(catalog.skills.some((skill) => skill.name === 'escaped'), false)
})
