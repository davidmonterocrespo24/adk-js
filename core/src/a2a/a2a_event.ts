import {
  Part as A2APart,
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {randomUUID} from '../utils/env_aware_utils.js';

/**
 * A2A event.
 */
export type A2AEvent =
  | Task
  | Message
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent;

/**
 * Checks if the event is an A2A TaskStatusUpdateEvent.
 */
export function isTaskStatusUpdateEvent(
  event: unknown,
): event is TaskStatusUpdateEvent {
  return (event as TaskStatusUpdateEvent)?.kind === 'status-update';
}

/**
 * Checks if the event is an A2A TaskArtifactUpdateEvent.
 */
export function isTaskArtifactUpdateEvent(
  event: unknown,
): event is TaskArtifactUpdateEvent {
  return (event as TaskArtifactUpdateEvent)?.kind === 'artifact-update';
}

/**
 * Checks if the event is an A2A Message.
 */
export function isMessage(event: unknown): event is Message {
  return (event as Message)?.kind === 'message';
}

/**
 * Checks if the event is an A2A Task.
 */
export function isTask(event: unknown): event is Task {
  return (event as Task)?.kind === 'task';
}

/**
 * Checks if the event is a failed task status update event.
 */
export function isFailedTaskStatusUpdateEvent(
  event: unknown,
): event is TaskStatusUpdateEvent {
  return isTaskStatusUpdateEvent(event) && event.status.state === 'failed';
}

export function isTerminalTaskStatusUpdateEvent(
  event: unknown,
): event is TaskStatusUpdateEvent {
  return (
    isTaskStatusUpdateEvent(event) &&
    ['completed', 'failed', 'input-required', 'canceled'].includes(
      event.status.state,
    )
  );
}

/**
 * Gets the error message from a failed task status update event.
 */
export function getFailedTaskStatusUpdateEventError(
  event: TaskStatusUpdateEvent,
): string | undefined {
  if (!isFailedTaskStatusUpdateEvent(event)) {
    return undefined;
  }

  const parts = event.status.message?.parts || [];
  if (parts.length === 0) {
    return undefined;
  }

  if (parts[0].kind !== 'text') {
    return undefined;
  }

  return parts[0].text;
}

/**
 * Creates a task submitted event.
 */
export function createTaskSubmittedEvent({
  taskId,
  contextId,
  message,
}: {
  taskId: string;
  contextId: string;
  message: Message;
}): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId,
    final: false,
    status: {
      state: 'submitted',
      message,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Creates a task working event.
 */
export function createTaskWorkingEvent({
  taskId,
  contextId,
  message,
}: {
  taskId: string;
  contextId: string;
  message: Message;
}): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId,
    final: false,
    status: {
      state: 'working',
      message,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Creates a task completed event.
 */
export function createTaskCompletedEvent({
  taskId,
  contextId,
}: {
  taskId: string;
  contextId: string;
}): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId,
    final: true,
    status: {
      state: 'completed',
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Creates an artifact update event.
 */
export function createArtifactUpdateEvent({
  taskId,
  contextId,
  artifactId,
  parts = [],
  metadata,
  append,
  lastChunk,
}: {
  taskId: string;
  contextId: string;
  artifactId?: string;
  parts?: A2APart[];
  metadata?: Record<string, unknown>;
  append?: boolean;
  lastChunk?: boolean;
}): TaskArtifactUpdateEvent {
  return {
    kind: 'artifact-update',
    taskId,
    contextId,
    append,
    lastChunk,
    artifact: {
      artifactId: artifactId || randomUUID(),
      parts,
      metadata,
    },
  };
}

/**
 * Creates an error message for task execution failure.
 */
export function createTaskFailedEvent({
  taskId,
  contextId,
  error,
}: {
  taskId: string;
  contextId: string;
  error: Error;
}): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId,
    final: true,
    status: {
      state: 'failed',
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'agent',
        taskId,
        contextId,
        parts: [
          {
            kind: 'text',
            text: error.message,
          },
        ],
      },
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Creates an error message for missing input for a function call.
 */
export function createInputMissingErrorEvent({
  inputRequiredParts,
  functionCallId,
  taskId,
  contextId,
}: {
  inputRequiredParts: A2APart[];
  functionCallId: string;
  taskId: string;
  contextId: string;
}): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId,
    final: true,
    status: {
      state: 'input-required',
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'agent',
        taskId,
        contextId,
        parts: [
          ...inputRequiredParts.filter((p) => !p.metadata?.validation_error),
          {
            kind: 'text',
            text: `no input provided for function call ID ${functionCallId}`,
            metadata: {
              validation_error: true,
            },
          },
        ],
      },
      timestamp: new Date().toISOString(),
    },
  };
}
