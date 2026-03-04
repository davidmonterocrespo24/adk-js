/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Part as A2APart,
  Message,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {RequestContext} from '@a2a-js/sdk/server';
import {Event} from '../events/event.js';
import {EventActions} from '../events/event_actions.js';
import {InputRequiredProcessor} from './input_required_processor.js';
import {A2AMetadataKeys} from './metadata_converter_utils.js';
import {toA2AParts} from './part_converter_utils.js';

/**
 * EventProcessor processes ADK events and converts them to A2A events.
 */
export class EventProcessor {
  private readonly inputRequiredProcessor: InputRequiredProcessor;
  private terminalActions: Partial<EventActions> = {};
  private responseId?: string;
  private partialResponseId?: string;
  private failedEvent?: TaskStatusUpdateEvent;

  constructor(private readonly reqCtx: RequestContext) {
    this.inputRequiredProcessor = new InputRequiredProcessor(reqCtx);
  }

  /**
   * Processes an ADK event and returns an A2A TaskArtifactUpdateEvent if applicable.
   */
  async process(event?: Event): Promise<TaskArtifactUpdateEvent | undefined> {
    if (!event) {
      return undefined;
    }

    this.updateTerminalActions(event);

    const eventMeta: Record<string, unknown> = {};

    const resp = event;
    if (resp.errorCode || resp.errorMessage) {
      if (!this.failedEvent) {
        const terminalEventMeta = {...eventMeta};
        this.failedEvent = this.toTaskFailedUpdateEvent(
          new Error(resp.errorMessage || resp.errorCode),
          terminalEventMeta,
        );
      }
    }

    const processedEvent = this.inputRequiredProcessor.process(event);
    const parts = toA2AParts(processedEvent.content?.parts);
    if (!parts || parts.length === 0) {
      return undefined;
    }

    let result: TaskArtifactUpdateEvent;

    if (processedEvent.partial) {
      result = this.newPartialArtifactUpdate(this.partialResponseId, parts);
      if (result.artifact?.artifactId) {
        this.partialResponseId = result.artifact.artifactId;
      }
    } else {
      result = this.newArtifactUpdate(this.responseId, parts);
      if (result.artifact?.artifactId) {
        this.responseId = result.artifact.artifactId;
      }
    }

    if (Object.keys(eventMeta).length > 0) {
      if (!result.artifact) {
        result.artifact = {artifactId: '', parts: []}; // Ensure it matches Artifact1 minimally
      }
      result.artifact.metadata = {...result.artifact.metadata, ...eventMeta};
    }

    return result;
  }

  private newArtifactUpdate(
    id: string | undefined,
    parts: A2APart[],
  ): TaskArtifactUpdateEvent {
    const artifactId = id || crypto.randomUUID();
    const result: TaskArtifactUpdateEvent = {
      kind: 'artifact-update',
      taskId: '',
      contextId: '',
      artifact: {
        artifactId,
        parts: parts,
        metadata: {[A2AMetadataKeys.PARTIAL]: false},
      },
      append: !!id,
    };

    return result;
  }

  private newPartialArtifactUpdate(
    id: string | undefined,
    parts: A2APart[],
  ): TaskArtifactUpdateEvent {
    const ev = this.newArtifactUpdate(id, parts);
    ev.artifact!.metadata = {[A2AMetadataKeys.PARTIAL]: true};
    ev.append = false;
    return ev;
  }

  makeFinalArtifactUpdate(): TaskArtifactUpdateEvent | undefined {
    if (!this.partialResponseId) {
      return undefined;
    }
    return {
      kind: 'artifact-update',
      taskId: '',
      contextId: '',
      artifact: {
        artifactId: this.partialResponseId,
        parts: [],
        metadata: {[A2AMetadataKeys.PARTIAL]: true},
      },
      lastChunk: true,
    };
  }

  makeFinalStatusUpdate(): TaskStatusUpdateEvent {
    if (this.failedEvent) {
      this.setActionsMeta(this.failedEvent, this.terminalActions);
      return this.failedEvent;
    }
    if (this.inputRequiredProcessor.event) {
      this.setActionsMeta(
        this.inputRequiredProcessor.event,
        this.terminalActions,
      );
      return this.inputRequiredProcessor.event;
    }

    const ev: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: '',
      contextId: '',
      status: {
        state: 'completed',
      },
      final: true,
    };
    this.setActionsMeta(ev, this.terminalActions);
    return ev;
  }

  makeTaskFailedEvent(cause: Error, _event?: Event): TaskStatusUpdateEvent {
    return this.toTaskFailedUpdateEvent(cause, {});
  }

  private updateTerminalActions(event: Event) {
    if (event.actions?.escalate) {
      this.terminalActions.escalate = true;
    }
    if (event.actions?.transferToAgent) {
      this.terminalActions.transferToAgent = event.actions.transferToAgent;
    }
  }

  private toTaskFailedUpdateEvent(
    cause: Error,
    meta: Record<string, unknown>,
  ): TaskStatusUpdateEvent {
    const msg: Message = {
      kind: 'message',
      messageId: crypto.randomUUID(),
      role: 'agent',
      parts: [{kind: 'text', text: cause.message}],
    };
    return {
      kind: 'status-update',
      taskId: '',
      contextId: '',
      status: {
        state: 'failed',
        message: msg,
      },
      metadata: meta,
      final: true,
    };
  }

  private setActionsMeta(
    event: TaskStatusUpdateEvent,
    actions: Partial<EventActions>,
  ) {
    if (!event.metadata) {
      event.metadata = {};
    }
    if (actions.escalate) {
      event.metadata['escalate'] = true;
    }
    if (actions.transferToAgent) {
      event.metadata['transfer_to_agent'] = actions.transferToAgent;
    }
  }
}
