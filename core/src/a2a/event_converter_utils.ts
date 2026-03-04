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
import {
  CitationMetadata,
  Part as GenAIPart,
  GroundingMetadata,
  UsageMetadata,
  createModelContent,
} from '@google/genai';
import {Event as AdkEvent, createEvent} from '../events/event.js';
import {createEventActions} from '../events/event_actions.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {
  A2AEvent,
  getFailedTaskStatusUpdateEventError,
  isFailedTaskStatusUpdateEvent,
  isMessage,
  isTask,
  isTaskArtifactUpdateEvent,
  isTaskStatusUpdateEvent,
  isTerminalTaskStatusUpdateEvent,
} from './a2a_event.js';
import {
  A2AMetadataKeys,
  getA2AEventMetadata,
} from './metadata_converter_utils.js';
import {toA2AParts, toGenAIPart, toGenAIParts} from './part_converter_utils.js';

const ROLE_USER = 'user';
const ROLE_MODEL = 'model';

/**
 * Converts a session Event to an A2A Message.
 */
export function toA2AMessage(
  event: AdkEvent,
  {
    appName,
    userId,
    sessionId,
  }: {appName: string; userId: string; sessionId: string},
): Message {
  return {
    kind: 'message',
    messageId: randomUUID(),
    role: event.author === ROLE_USER ? 'user' : 'agent',
    parts: toA2AParts(event.content?.parts || [], event.longRunningToolIds),
    metadata: getA2AEventMetadata(event, {appName, userId, sessionId}),
  };
}

/**
 * Converts an A2A Event to a Session Event.
 */
export function toAdkEvent(
  event: A2AEvent,
  invocationId: string,
  agentName: string,
): AdkEvent | undefined {
  if (isMessage(event)) {
    return messageToAdkEvent(event, invocationId, agentName);
  }

  if (isTask(event)) {
    return taskToAdkEvent(event, invocationId, agentName);
  }

  if (isTaskArtifactUpdateEvent(event)) {
    return artifactUpdateToAdkEvent(event, invocationId, agentName);
  }

  if (isTaskStatusUpdateEvent(event)) {
    if (event.final) {
      return finalTaskStatusUpdateToAdkEvent(event, invocationId, agentName);
    }

    if (!event.status.message) {
      return undefined;
    }

    return messageToAdkEvent(
      event.status.message,
      invocationId,
      agentName,
      event,
    );
  }

  return undefined;
}

function messageToAdkEvent(
  msg: Message,
  invocationId: string,
  agentName: string,
  parentEvent?: TaskStatusUpdateEvent,
): AdkEvent {
  const parts = toGenAIParts(msg.parts);

  return {
    ...createAdkEventFromMetadata(parentEvent || msg),
    invocationId,
    author: msg.role === ROLE_USER ? ROLE_USER : agentName,
    content: parts.length > 0 ? {role: toAdkRole(msg.role), parts} : undefined,
    turnComplete: msg.role === ROLE_USER || parentEvent?.final || false,
    partial: !parentEvent?.final,
  };
}

function artifactUpdateToAdkEvent(
  a2aEvent: TaskArtifactUpdateEvent,
  invocationId: string,
  agentName: string,
): AdkEvent | undefined {
  const partsToConvert = a2aEvent.artifact?.parts || [];
  if (partsToConvert.length === 0) {
    return undefined;
  }

  const parts = toGenAIParts(partsToConvert);

  return {
    ...createAdkEventFromMetadata(a2aEvent),
    invocationId,
    author: agentName,
    content: createModelContent(parts),
    longRunningToolIds: getLongRunningToolIDs(partsToConvert),
    partial: !!a2aEvent.artifact?.metadata?.[A2AMetadataKeys.PARTIAL],
  };
}

function finalTaskStatusUpdateToAdkEvent(
  a2aEvent: TaskStatusUpdateEvent,
  invocationId: string,
  agentName: string,
): AdkEvent | undefined {
  const partsToConvert = a2aEvent.status.message?.parts || [];
  if (partsToConvert.length === 0) {
    return undefined;
  }

  const parts = toGenAIParts(partsToConvert);
  const isFailedTask = isFailedTaskStatusUpdateEvent(a2aEvent);
  const hasContent = !isFailedTask && parts.length > 0;

  return {
    ...createAdkEventFromMetadata(a2aEvent),
    invocationId,
    author: agentName,
    longRunningToolIds: getLongRunningToolIDs(partsToConvert),
    turnComplete: true,
    errorMessage: isFailedTask
      ? getFailedTaskStatusUpdateEventError(a2aEvent)
      : undefined,
    content: hasContent ? createModelContent(parts) : undefined,
  };
}

function taskToAdkEvent(
  a2aTask: Task,
  invocationId: string,
  agentName: string,
): AdkEvent | undefined {
  const parts: GenAIPart[] = [];
  const longRunningToolIds: string[] = [];

  if (a2aTask.artifacts) {
    for (const artifact of a2aTask.artifacts) {
      if (artifact.parts?.length > 0) {
        const artifactParts = toGenAIParts(artifact.parts);
        parts.push(...artifactParts);
        longRunningToolIds.push(...getLongRunningToolIDs(artifact.parts));
      }
    }
  }

  if (a2aTask.status?.message) {
    const a2aParts = a2aTask.status.message.parts;
    const genAIParts = toGenAIParts(a2aParts);

    parts.push(...genAIParts);
    longRunningToolIds.push(...getLongRunningToolIDs(a2aParts));
  }

  const isTerminal = isTerminalTaskStatusUpdateEvent(a2aTask);
  const isFailed = isFailedTaskStatusUpdateEvent(a2aTask);

  if (parts.length === 0 && !isTerminal) {
    return undefined;
  }

  return {
    ...createAdkEventFromMetadata(a2aTask),
    invocationId,
    author: agentName,
    content: isFailed ? undefined : createModelContent(parts),
    errorMessage: isFailed
      ? getFailedTaskStatusUpdateEventError(a2aTask)
      : undefined,
    longRunningToolIds,
    turnComplete: isTerminal,
  };
}

function createAdkEventFromMetadata(a2aEvent: A2AEvent): AdkEvent {
  const metadata = a2aEvent.metadata || {};

  return createEvent({
    branch: metadata[A2AMetadataKeys.BRANCH] as string,
    author: metadata[A2AMetadataKeys.AUTHOR] as string,
    partial: metadata[A2AMetadataKeys.PARTIAL] as boolean,
    errorCode: metadata[A2AMetadataKeys.ERROR_CODE] as string,
    errorMessage: metadata[A2AMetadataKeys.ERROR_MESSAGE] as string,
    citationMetadata: metadata[
      A2AMetadataKeys.CITATION_METADATA
    ] as CitationMetadata,
    groundingMetadata: metadata[
      A2AMetadataKeys.GROUNDING_METADATA
    ] as GroundingMetadata,
    usageMetadata: metadata[A2AMetadataKeys.USAGE_METADATA] as UsageMetadata,
    customMetadata: metadata[A2AMetadataKeys.CUSTOM_METADATA] as Record<
      string,
      unknown
    >,
    actions: createEventActions({
      escalate: !!metadata[A2AMetadataKeys.ESCALATE],
      transferToAgent: metadata[A2AMetadataKeys.TRANSFER_TO_AGENT] as string,
    }),
  });
}

function getLongRunningToolIDs(parts: A2APart[]): string[] {
  const ids: string[] = [];

  for (const a2aPart of parts) {
    if (a2aPart.metadata && a2aPart.metadata[A2AMetadataKeys.IS_LONG_RUNNING]) {
      const genAIPart = toGenAIPart(a2aPart);
      if (genAIPart.functionCall && genAIPart.functionCall.id) {
        ids.push(genAIPart.functionCall.id);
      }
    }
  }

  return ids;
}

function toAdkRole(role: string): 'user' | 'model' {
  return role === ROLE_USER ? ROLE_USER : ROLE_MODEL;
}
