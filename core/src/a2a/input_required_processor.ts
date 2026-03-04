/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Message, TaskStatusUpdateEvent} from '@a2a-js/sdk';
import {RequestContext} from '@a2a-js/sdk/server';
import {Content, Part} from '@google/genai';
import {cloneDeep} from 'lodash-es';
import {Event} from '../events/event.js';
import {createInputMissingErrorEvent} from './a2a_event.js';
import {toA2AParts, toGenAIParts} from './part_converter_utils.js';

/**
 * InputRequiredProcessor handles long-running function tool calls by accumulating them.
 */
export class InputRequiredProcessor {
  event?: TaskStatusUpdateEvent;
  private addedParts: Part[] = [];

  constructor(private readonly requestContext: RequestContext) {}

  /**
   * Processes the event to handle long-running tool calls.
   */
  process(event: Event): Event {
    const resp = event;

    // Check if event has content
    if (!resp.content || !resp.content.parts) {
      return event;
    }

    const longRunningCallIDs: string[] = [];
    const inputRequiredParts: Part[] = [];
    const remainingParts: Part[] = [];

    for (const part of resp.content.parts) {
      let callID = '';
      if (
        part.functionCall &&
        event.longRunningToolIds?.includes(part.functionCall.id || '')
      ) {
        callID = part.functionCall.id || '';
      } else if (isLongRunningResponse(event, this.event, part)) {
        // Correctly access ID from FunctionResponse
        callID = part.functionResponse?.id || '';
      }

      if (!callID) {
        remainingParts.push(part);
        continue;
      }

      const added = this.addedParts.some((p) => {
        if (
          part.functionCall &&
          p.functionCall &&
          part.functionCall.id === p.functionCall.id
        ) {
          return true;
        }

        return (
          part.functionResponse &&
          p.functionResponse &&
          part.functionResponse.id === p.functionResponse.id
        );
      });

      if (added) {
        continue;
      }

      this.addedParts.push(part);
      inputRequiredParts.push(part);
      longRunningCallIDs.push(callID);
    }

    if (inputRequiredParts.length > 0) {
      const a2aParts = toA2AParts(inputRequiredParts);

      if (this.event && this.event.status.message) {
        this.event.status.message.parts.push(...a2aParts);
      } else {
        const msg: Message = {
          kind: 'message',
          messageId: crypto.randomUUID(),
          role: 'agent', // Use 'agent' role for agent responses generally, or 'user' if A2A specific logic requires it. Go uses `a2a.MessageRoleAgent`.
          parts: a2aParts,
        };
        // Construct the event
        this.event = {
          kind: 'status-update',
          taskId: '',
          contextId: '',
          status: {
            state: 'input-required',
            message: msg,
          },
          final: true,
        };
      }
    }

    if (remainingParts.length === resp.content.parts.length) {
      return event;
    }

    // Clone event and update content parts
    const modifiedEvent = cloneDeep(event);
    if (modifiedEvent.content) {
      modifiedEvent.content = {...modifiedEvent.content, parts: remainingParts};
    }

    return modifiedEvent;
  }
}

function isLongRunningResponse(
  adkEvent: Event,
  a2aEvent: TaskStatusUpdateEvent | undefined,
  part: Part,
): boolean {
  if (!part.functionResponse) {
    return false;
  }
  const id = part.functionResponse.id;
  if (id && adkEvent.longRunningToolIds?.includes(id)) {
    return true;
  }

  if (!a2aEvent || !a2aEvent.status.message) {
    return false;
  }

  for (const p of a2aEvent.status.message.parts) {
    if (
      p.kind === 'data' &&
      p.data.functionCall &&
      (p.data.functionCall as {id?: string}).id === id
    ) {
      return true;
    }
  }

  return false;
}

export function handleInputRequired(
  reqCtx: RequestContext,
  content: Content,
): TaskStatusUpdateEvent | undefined {
  const task = reqCtx.task;

  if (!task || task.status.state !== 'input-required' || !task.status.message) {
    return undefined;
  }

  const statusMsg = task.status.message;
  const taskParts = toGenAIParts(statusMsg.parts);

  for (const statusPart of taskParts) {
    if (!statusPart.functionCall?.id) {
      continue;
    }

    const id = statusPart.functionCall.id;
    const hasMatchingResponse = (content?.parts || []).some(
      (p) => p.functionResponse?.id === id,
    );

    if (!hasMatchingResponse) {
      return createInputMissingErrorEvent({
        inputRequiredParts: statusMsg.parts,
        functionCallId: id!,
        taskId: reqCtx.taskId,
        contextId: reqCtx.contextId,
      });
    }
  }

  return undefined;
}
