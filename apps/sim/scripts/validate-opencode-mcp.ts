import { randomUUID } from 'node:crypto'
import { db } from '@sim/db'
import { apiKey, memory, workflow, workflowMcpServer, workflowMcpTool } from '@sim/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import { generateSchemaFromBlocks } from '@/lib/mcp/workflow-mcp-sync'
import { sanitizeToolName } from '@/lib/mcp/workflow-tool-schema'
import {
  listOpenCodeAgents,
  listOpenCodeModels,
  listOpenCodeProviders,
  listOpenCodeRepositories,
} from '@/lib/opencode/service'
import { getEffectiveBlockOutputs } from '@/lib/workflows/blocks/block-outputs'
import { buildDefaultWorkflowArtifacts } from '@/lib/workflows/defaults'
import { deployWorkflow, saveWorkflowToNormalizedTables } from '@/lib/workflows/persistence/utils'
import { buildDefaultCanonicalModes } from '@/lib/workflows/subblocks/visibility'
import type { InputFormatField } from '@/lib/workflows/types'
import { getBlock } from '@/blocks'
import type { BlockConfig } from '@/blocks/types'
import type { BlockState, SubBlockState, WorkflowState } from '@/stores/workflows/workflow/types'

interface ValidationCaller {
  userId: string
  workspaceId: string
  apiKey: string
}

interface JsonRpcResponse<T> {
  jsonrpc: string
  id: number
  result?: T
  error?: {
    code: number
    message: string
  }
}

interface McpToolListResult {
  tools: Array<{
    name: string
    description: string
    inputSchema: Record<string, unknown>
  }>
}

interface McpToolCallResult {
  content: Array<{
    type: string
    text?: string
  }>
  isError?: boolean
}

interface OpenCodeToolOutput {
  content?: string
  threadId?: string
  cost?: number
  error?: string
}

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`)
}

function assertValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message)
  }

  return value
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function cloneInitialValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneInitialValue(item))
  }

  if (value && typeof value === 'object') {
    return { ...(value as Record<string, unknown>) }
  }

  return value ?? null
}

function resolveInitialValue(subBlock: BlockConfig['subBlocks'][number]): unknown {
  if (typeof subBlock.value === 'function') {
    try {
      return cloneInitialValue(subBlock.value({}))
    } catch {
      return null
    }
  }

  if (subBlock.defaultValue !== undefined) {
    return cloneInitialValue(subBlock.defaultValue)
  }

  if (subBlock.type === 'input-format' || subBlock.type === 'response-format') {
    return [
      {
        id: randomUUID(),
        name: '',
        type: 'string',
        value: '',
        collapsed: false,
      },
    ]
  }

  if (subBlock.type === 'table') {
    return []
  }

  return null
}

function createBlockState(
  type: string,
  id: string,
  position: { x: number; y: number }
): BlockState {
  const blockConfig = getBlock(type)
  if (!blockConfig) {
    throw new Error(`Block not found: ${type}`)
  }

  const subBlocks: Record<string, SubBlockState> = {}
  for (const subBlock of blockConfig.subBlocks) {
    subBlocks[subBlock.id] = {
      id: subBlock.id,
      type: subBlock.type,
      value: resolveInitialValue(subBlock) as SubBlockState['value'],
    }
  }

  const blockData: Record<string, unknown> = {}
  const canonicalModes = buildDefaultCanonicalModes(blockConfig.subBlocks)
  if (Object.keys(canonicalModes).length > 0) {
    blockData.canonicalModes = canonicalModes
  }

  return {
    id,
    type,
    name: blockConfig.name,
    position,
    subBlocks,
    outputs: getEffectiveBlockOutputs(type, subBlocks, {
      triggerMode: false,
      preferToolOutputs: true,
    }),
    enabled: true,
    horizontalHandles: true,
    advancedMode: false,
    triggerMode: false,
    height: 0,
    data: blockData,
    locked: false,
  }
}

async function resolveCaller(): Promise<ValidationCaller> {
  const configuredApiKey = process.env.SIM_VALIDATE_API_KEY || 'sim_manual_opencode_1773940396'
  const [record] = await db
    .select({
      userId: apiKey.userId,
      workspaceId: apiKey.workspaceId,
      key: apiKey.key,
    })
    .from(apiKey)
    .where(eq(apiKey.key, configuredApiKey))
    .limit(1)

  if (!record?.workspaceId) {
    throw new Error(`Workspace API key not found: ${configuredApiKey}`)
  }

  return {
    userId: record.userId,
    workspaceId: record.workspaceId,
    apiKey: record.key,
  }
}

async function createWorkflowRecord(
  caller: ValidationCaller
): Promise<{ workflowId: string; name: string }> {
  const workflowId = randomUUID()
  const name = `OpenCode MCP Validation ${Date.now()}`
  const now = new Date()

  await db.insert(workflow).values({
    id: workflowId,
    userId: caller.userId,
    workspaceId: caller.workspaceId,
    folderId: null,
    sortOrder: 0,
    name,
    description: 'Manual validation workflow for the OpenCode MCP block',
    color: '#3972F6',
    lastSynced: now,
    createdAt: now,
    updatedAt: now,
    isDeployed: false,
    isPublicApi: false,
    runCount: 0,
    variables: {},
  })

  return { workflowId, name }
}

async function buildWorkflowState(
  repository: string,
  providerId: string,
  modelId: string
): Promise<WorkflowState> {
  const { workflowState, startBlockId } = buildDefaultWorkflowArtifacts()
  const startBlock = workflowState.blocks[startBlockId]
  const inputFormat: InputFormatField[] = [
    {
      name: 'prompt',
      type: 'string',
      description: 'Prompt sent to the OpenCode workflow tool',
    },
    {
      name: 'new_thread',
      type: 'boolean',
      description: 'Force a new OpenCode thread',
    },
  ]
  startBlock.subBlocks.inputFormat.value = inputFormat as unknown as SubBlockState['value']
  startBlock.outputs = getEffectiveBlockOutputs(startBlock.type, startBlock.subBlocks, {
    triggerMode: false,
    preferToolOutputs: true,
  })

  const opencodeBlockId = randomUUID()
  const opencodeBlock = createBlockState('opencode', opencodeBlockId, { x: 360, y: 0 })
  opencodeBlock.subBlocks.repository.value = repository
  opencodeBlock.subBlocks.systemPrompt.value =
    'Always begin every answer with the exact token [SYSTEM_OK].'
  opencodeBlock.subBlocks.providerId.value = providerId
  opencodeBlock.subBlocks.modelId.value = modelId
  opencodeBlock.subBlocks.agent.value = ''
  opencodeBlock.subBlocks.prompt.value = '<start.prompt>'
  opencodeBlock.subBlocks.newThreadExpression.value = '<start.new_thread>'
  opencodeBlock.data = {
    ...(opencodeBlock.data || {}),
    canonicalModes: {
      ...((opencodeBlock.data?.canonicalModes as Record<string, 'basic' | 'advanced'>) || {}),
      newThread: 'advanced',
    },
  }
  opencodeBlock.outputs = getEffectiveBlockOutputs(opencodeBlock.type, opencodeBlock.subBlocks, {
    triggerMode: false,
    preferToolOutputs: true,
  })

  workflowState.blocks[opencodeBlockId] = opencodeBlock
  workflowState.edges.push({
    id: randomUUID(),
    source: startBlockId,
    target: opencodeBlockId,
  })
  workflowState.lastSaved = Date.now()

  return workflowState
}

async function createMcpServer(
  caller: ValidationCaller,
  workflowId: string,
  workflowName: string,
  state: WorkflowState
): Promise<{ serverId: string; toolName: string }> {
  const serverId = randomUUID()
  const toolName = sanitizeToolName(workflowName)
  const now = new Date()

  await db.insert(workflowMcpServer).values({
    id: serverId,
    workspaceId: caller.workspaceId,
    createdBy: caller.userId,
    name: `${workflowName} MCP`,
    description: 'Manual validation MCP server for the OpenCode block',
    isPublic: false,
    createdAt: now,
    updatedAt: now,
  })

  await db.insert(workflowMcpTool).values({
    id: randomUUID(),
    serverId,
    workflowId,
    toolName,
    toolDescription: 'Manual validation tool for the OpenCode block',
    parameterSchema: generateSchemaFromBlocks(state.blocks),
    createdAt: now,
    updatedAt: now,
  })

  return { serverId, toolName }
}

async function postJson<T>(url: string, apiKeyValue: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKeyValue,
    },
    body: JSON.stringify(body),
  })

  const payload = (await response.json()) as T
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`)
  }

  return payload
}

async function callMcp<T>(
  serverId: string,
  apiKeyValue: string,
  body: Record<string, unknown>
): Promise<JsonRpcResponse<T>> {
  return postJson<JsonRpcResponse<T>>(
    `http://localhost:3000/api/mcp/serve/${serverId}`,
    apiKeyValue,
    body
  )
}

function parseToolCall(response: JsonRpcResponse<McpToolCallResult>): OpenCodeToolOutput {
  if (response.error) {
    throw new Error(`MCP tool call failed: ${response.error.message}`)
  }

  const text = response.result?.content?.find((item) => item.type === 'text')?.text
  if (!text) {
    throw new Error('MCP tool call returned no text content')
  }

  return JSON.parse(text) as OpenCodeToolOutput
}

async function getMemoryRecord(workspaceId: string, workflowId: string, userId: string) {
  const key = `opencode:session:${workflowId}:user:${userId}`
  const [record] = await db
    .select({
      key: memory.key,
      data: memory.data,
      updatedAt: memory.updatedAt,
    })
    .from(memory)
    .where(and(eq(memory.workspaceId, workspaceId), eq(memory.key, key), isNull(memory.deletedAt)))
    .limit(1)

  return { key, record }
}

async function main(): Promise<void> {
  writeLine('Resolving caller and OpenCode options...')
  const caller = await resolveCaller()
  const repositories = await listOpenCodeRepositories()
  const repository = repositories.find((item) => item.id === 'sim') || repositories[0]
  assertValue(repository, 'No OpenCode repositories available')

  const providers = await listOpenCodeProviders(repository.id)
  const provider = providers.find((item) => item.id === 'opencode') || providers[0]
  assertValue(provider, 'No OpenCode providers available')

  const models = await listOpenCodeModels(provider.id, repository.id)
  const model = models.find((item) => item.id === 'big-pickle') || models[0]
  assertValue(model, 'No OpenCode models available')

  const agents = await listOpenCodeAgents(repository.id)

  writeLine(`Repository: ${repository.id}`)
  writeLine(`Provider: ${provider.id}`)
  writeLine(`Model: ${model.id}`)
  writeLine(`Agents available: ${agents.length}`)

  const { workflowId, name } = await createWorkflowRecord(caller)
  const state = await buildWorkflowState(repository.id, provider.id, model.id)

  const saveResult = await saveWorkflowToNormalizedTables(workflowId, state)
  assertCondition(saveResult.success, `Failed to save workflow: ${saveResult.error}`)

  const deployResult = await deployWorkflow({
    workflowId,
    deployedBy: caller.userId,
    workflowName: name,
  })
  assertCondition(deployResult.success, `Failed to deploy workflow: ${deployResult.error}`)

  const { serverId, toolName } = await createMcpServer(caller, workflowId, name, state)

  writeLine(`Workflow ID: ${workflowId}`)
  writeLine(`Server ID: ${serverId}`)
  writeLine(`Tool name: ${toolName}`)

  const initialize = await callMcp<{ protocolVersion: string }>(serverId, caller.apiKey, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'manual-validation',
        version: '1.0.0',
      },
    },
  })

  const toolsList = await callMcp<McpToolListResult>(serverId, caller.apiKey, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  })

  const listedTool = assertValue(
    toolsList.result?.tools.find((tool) => tool.name === toolName),
    'Workflow tool was not listed by MCP'
  )

  const firstCall = parseToolCall(
    await callMcp<McpToolCallResult>(serverId, caller.apiKey, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: {
          prompt: 'Answer with one short word that means first.',
          new_thread: false,
        },
      },
    })
  )

  const secondCall = parseToolCall(
    await callMcp<McpToolCallResult>(serverId, caller.apiKey, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: {
          prompt: 'Answer with one short word that means second.',
          new_thread: false,
        },
      },
    })
  )

  const thirdCall = parseToolCall(
    await callMcp<McpToolCallResult>(serverId, caller.apiKey, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: {
          prompt: 'Answer with one short word that means fresh.',
          new_thread: true,
        },
      },
    })
  )

  const memoryState = await getMemoryRecord(caller.workspaceId, workflowId, caller.userId)

  const result = {
    initializeProtocolVersion: initialize.result?.protocolVersion,
    repositoryRouteExpectation: repositories.map((item) => item.id),
    listedToolSchema: listedTool.inputSchema,
    firstCall,
    secondCall,
    thirdCall,
    threadReused: Boolean(firstCall.threadId && firstCall.threadId === secondCall.threadId),
    newThreadCreated: Boolean(
      thirdCall.threadId &&
        firstCall.threadId &&
        thirdCall.threadId !== firstCall.threadId &&
        thirdCall.threadId !== secondCall.threadId
    ),
    systemPromptApplied: Boolean(firstCall.content?.startsWith('[SYSTEM_OK]')),
    memoryKey: memoryState.key,
    memoryRecord: memoryState.record,
    workflowId,
    serverId,
    toolName,
  }

  writeLine(JSON.stringify(result, null, 2))
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
})
