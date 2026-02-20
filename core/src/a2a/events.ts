/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Part as A2APart,
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {Part} from '@google/genai';
import {Event, createEvent} from '../events/event.js';
import {EventActions, createEventActions} from '../events/event_actions.js';
import {toA2AParts} from './parts.js';

type A2AEvent =
  | Task
  | Message
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent;

const KEY_METADATA_PARTIAL = 'partial';
const KEY_CUSTOM_META_TASK_ID = 'a2a/task_id';
const KEY_CUSTOM_META_CONTEXT_ID = 'a2a/context_id';
const KEY_METADATA_ESCALATE = 'escalate';
const KEY_METADATA_TRANSFER_TO_AGENT = 'transfer_to_agent';
const KEY_METADATA_LONG_RUNNING = 'a2a/is_long_running';
const KEY_METADATA_THOUGHT = 'thought';

const ROLE_USER = 'user';
const ROLE_MODEL = 'model';

/**
 * Converts a session Event to an A2A Message.
 */
export async function toA2AMessage(event: Event): Promise<Message | undefined> {
  if (!event) {
    return undefined;
  }

  const parts = await toA2AParts(
    event.content?.parts || [],
    event.longRunningToolIds,
  );

  const role: 'user' | 'agent' = event.author === ROLE_USER ? 'user' : 'agent';

  const msg: Message = {
    kind: 'message',
    messageId: crypto.randomUUID(),
    role,
    parts,
    metadata: {},
  };

  const actionsMeta = toActionsMeta(event.actions);
  Object.assign(msg.metadata!, actionsMeta);

  if (event.customMetadata) {
    Object.assign(msg.metadata!, event.customMetadata);
  }

  return msg;
}

/**
 * Converts an A2A Event to a Session Event.
 */
export async function toSessionEvent(
  event: A2AEvent | unknown,
  invocationId: string,
  agentName: string,
): Promise<Event | undefined> {
  if (isTaskStatusUpdateEvent(event)) {
    if (event.final) {
      return finalTaskStatusUpdateToEvent(event, invocationId, agentName);
    }
    if (!event.status.message) {
      return undefined;
    }
    return messageToEvent(event.status.message, invocationId, agentName, event);
  }

  if (isMessage(event)) {
    return messageToEvent(event, invocationId, agentName);
  }

  if (isTaskArtifactUpdateEvent(event)) {
    return artifactUpdateToEvent(event, invocationId, agentName);
  }

  if (isTask(event)) {
    return taskToEvent(event, invocationId, agentName);
  }

  return undefined;
}

function isTaskStatusUpdateEvent(
  event: unknown,
): event is TaskStatusUpdateEvent {
  return (event as TaskStatusUpdateEvent)?.kind === 'status-update';
}

function isTaskArtifactUpdateEvent(
  event: unknown,
): event is TaskArtifactUpdateEvent {
  return (event as TaskArtifactUpdateEvent)?.kind === 'artifact-update';
}
function isMessage(event: unknown): event is Message {
  return (event as Message)?.kind === 'message';
}

function isTask(event: unknown): event is Task {
  return (event as Task)?.kind === 'task';
}

async function messageToEvent(
  msg: Message,
  invocationId: string,
  agentName: string,
  parentEvent?: TaskStatusUpdateEvent,
): Promise<Event> {
  const parts = await toGenAIParts(msg.parts);
  const event = createEvent({
    invocationId,
    author: msg.role === ROLE_USER ? ROLE_USER : agentName,
  });

  if (parts.length > 0) {
    event.content = {
      role: msg.role === ROLE_USER ? ROLE_USER : ROLE_MODEL,
      parts,
    };
  }

  if (parentEvent && !parentEvent.final) {
    // In Go, for intermediate status updates (thoughts), set thought=true on parts
    // and set partial=true on the event logic
    event.partial = true;

    if (event.content?.parts) {
      for (const part of event.content.parts) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (part as any)[KEY_METADATA_THOUGHT] = true;
      }
    }
  }

  const metaSource = parentEvent || msg;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processA2AMeta(metaSource as any, event);

  event.turnComplete = !parentEvent || !!parentEvent.final;
  if (parentEvent && !parentEvent.final) {
    event.turnComplete = false;
  }

  if (msg.role === ROLE_USER) {
    event.turnComplete = true;
  }

  return event;
}

async function artifactUpdateToEvent(
  event: TaskArtifactUpdateEvent,
  invocationId: string,
  agentName: string,
): Promise<Event | undefined> {
  const partsToConvert = event.artifact?.parts || [];

  if (partsToConvert.length === 0) {
    return undefined;
  }

  const parts = await toGenAIParts(partsToConvert);

  const sessionEvent = createEvent({
    invocationId,
    author: agentName,
    content: {role: ROLE_MODEL, parts},
  });

  sessionEvent.longRunningToolIds = getLongRunningToolIDs(
    partsToConvert,
    parts,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processA2AMeta(event as any, sessionEvent);

  if (event.artifact?.metadata?.[KEY_METADATA_PARTIAL]) {
    sessionEvent.partial = true;
  } else {
    // Default to true for streaming artifact updates
    sessionEvent.partial = true;
  }

  return sessionEvent;
}

async function finalTaskStatusUpdateToEvent(
  update: TaskStatusUpdateEvent,
  invocationId: string,
  agentName: string,
): Promise<Event | undefined> {
  const event = createEvent({
    invocationId,
    author: agentName,
  });

  let parts: Part[] = [];
  if (update.status.message) {
    parts = await toGenAIParts(update.status.message.parts);
  }

  if (update.status.state === 'failed' && parts.length === 1 && parts[0].text) {
    event.errorMessage = parts[0].text;
  } else if (parts.length > 0) {
    event.content = {role: ROLE_MODEL, parts};
  }

  processA2AMeta(update, event);

  if (update.status.message) {
    event.longRunningToolIds = getLongRunningToolIDs(
      update.status.message.parts,
      parts,
    );
  }

  event.turnComplete = true;

  return event;
}

async function taskToEvent(
  task: Task,
  invocationId: string,
  agentName: string,
): Promise<Event | undefined> {
  const event = createEvent({
    invocationId,
    author: agentName,
  });

  let parts: Part[] = [];
  let longRunningToolIds: string[] = [];

  // Artifacts
  if (task.artifacts) {
    for (const artifact of task.artifacts) {
      if (artifact.parts) {
        const artifactParts = await toGenAIParts(artifact.parts);
        parts = parts.concat(artifactParts);
        longRunningToolIds = longRunningToolIds.concat(
          getLongRunningToolIDs(artifact.parts, artifactParts),
        );
      }
    }
  }

  // Status Message
  if (task.status?.message) {
    const msgParts = await toGenAIParts(task.status.message.parts);

    if (
      task.status.state === 'failed' &&
      msgParts.length === 1 &&
      msgParts[0].text
    ) {
      event.errorMessage = msgParts[0].text;
    } else {
      parts = parts.concat(msgParts);
    }
    longRunningToolIds = longRunningToolIds.concat(
      getLongRunningToolIDs(task.status.message.parts, msgParts),
    );
  }

  const isTerminal =
    task.status?.state === 'completed' ||
    task.status?.state === 'failed' ||
    task.status?.state === 'input-required' ||
    task.status?.state === 'canceled';

  if (parts.length === 0 && !isTerminal) {
    return undefined;
  }

  if (parts.length > 0) {
    event.content = {role: ROLE_MODEL, parts};
  }

  if (task.status?.state === 'input-required') {
    event.longRunningToolIds = longRunningToolIds;
  }

  processA2AMeta(task, event);
  event.turnComplete = isTerminal;

  return event;
}

// Helpers

export function toGenAIParts(a2aParts: A2APart[]): Part[] {
  const genaiParts: Part[] = [];
  for (const p of a2aParts) {
    if (p.kind === 'text') {
      genaiParts.push({text: p.text});
    } else if (p.kind === 'file') {
      if ('bytes' in p.file) {
        genaiParts.push({
          inlineData: {data: p.file.bytes, mimeType: p.file.mimeType || ''},
        });
      } else if ('uri' in p.file) {
        genaiParts.push({
          fileData: {fileUri: p.file.uri, mimeType: p.file.mimeType || ''},
        });
      }
    } else if (p.kind === 'data') {
      const data = p.data as Record<string, unknown>;
      if (data.functionCall) genaiParts.push({functionCall: data.functionCall});
      else if (data.functionResponse)
        genaiParts.push({functionResponse: data.functionResponse});
      else if (data.executableCode)
        genaiParts.push({executableCode: data.executableCode});
      else if (data.codeExecutionResult)
        genaiParts.push({codeExecutionResult: data.codeExecutionResult});
    }
  }
  return genaiParts;
}

function processA2AMeta(
  source: {metadata?: Record<string, unknown>},
  event: Event,
) {
  if (!source.metadata) return;

  // Actions
  if (source.metadata[KEY_METADATA_ESCALATE]) {
    if (!event.actions) event.actions = createEventActions();
    event.actions.escalate = true;
  }
  if (source.metadata[KEY_METADATA_TRANSFER_TO_AGENT]) {
    if (!event.actions) event.actions = createEventActions();
    event.actions.transferToAgent = source.metadata[
      KEY_METADATA_TRANSFER_TO_AGENT
    ] as string;
  }

  // Custom Metadata
  const taskId = source.metadata[KEY_CUSTOM_META_TASK_ID] as string;
  const contextId = source.metadata[KEY_CUSTOM_META_CONTEXT_ID] as string;

  if (taskId || contextId) {
    if (!event.customMetadata) event.customMetadata = {};

    if (taskId) event.customMetadata[KEY_CUSTOM_META_TASK_ID] = taskId;
    if (contextId) event.customMetadata[KEY_CUSTOM_META_CONTEXT_ID] = contextId;
  }
}

function toActionsMeta(actions: EventActions): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (actions.escalate) {
    meta[KEY_METADATA_ESCALATE] = true;
  }
  if (actions.transferToAgent) {
    meta[KEY_METADATA_TRANSFER_TO_AGENT] = actions.transferToAgent;
  }
  return meta;
}

function getLongRunningToolIDs(parts: A2APart[], converted: Part[]): string[] {
  const ids: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.metadata && p.metadata[KEY_METADATA_LONG_RUNNING]) {
      const fnCall = converted[i];
      if (fnCall.functionCall && fnCall.functionCall.name) {
        ids.push(fnCall.functionCall.name);
      }
    }
  }
  return ids;
}

/**
 * Returns A2A task and context IDs if they are present in session event custom metadata.
 */
export function getA2ATaskInfo(event: Event): {
  taskId?: string;
  contextId?: string;
} {
  const customMeta = event.customMetadata;

  return {
    taskId: customMeta?.[KEY_CUSTOM_META_TASK_ID] as string | undefined,
    contextId: customMeta?.[KEY_CUSTOM_META_CONTEXT_ID] as string | undefined,
  };
}

/**
 * Creates a session event custom metadata with A2A task and context IDs.
 */
export function toCustomMetadata(
  taskId: string,
  contextId: string,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (taskId) meta[KEY_CUSTOM_META_TASK_ID] = taskId;
  if (contextId) meta[KEY_CUSTOM_META_CONTEXT_ID] = contextId;
  return meta;
}
