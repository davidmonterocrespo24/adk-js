/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RequestContext} from '@a2a-js/sdk/server';
import {
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
} from '@google/genai';
import {Event} from '../events/event.js';
import {createEventActions, EventActions} from '../events/event_actions.js';
import {ExecutorConfig} from './agent_executor.js';

export const customMetaTaskIdKey = toAdkMetaKey('task_id');
export const customMetaContextIdKey = toAdkMetaKey('context_id');

export const metadataEscalateKey = toA2aMetaKey('escalate');
export const metadataTransferToAgentKey = toA2aMetaKey('transfer_to_agent');
export const metadataErrorCodeKey = toA2aMetaKey('error_code');
export const metadataCitationKey = toA2aMetaKey('citation_metadata');
export const metadataGroundingKey = toA2aMetaKey('grounding_metadata');
export const metadataUsageKey = toA2aMetaKey('usage_metadata');
export const metadataCustomMetaKey = toA2aMetaKey('custom_metadata');
export const metadataPartialKey = toA2aMetaKey('partial');

/**
 * Adds a prefix used to differentiage ADK-related values stored in Metadata an A2A event.
 */
export function toA2aMetaKey(key: string): string {
  return 'adk_' + key;
}

/**
 * Adds a prefix used to differentiage A2A-related values stored in custom metadata of an ADK session event.
 */
export function toAdkMetaKey(key: string): string {
  return 'a2a:' + key;
}

export interface InvocationMeta {
  userId: string;
  sessionId: string;
  agentName: string;
  reqCtx: RequestContext;
  eventMeta: Record<string, unknown>;
}

export function toInvocationMeta(
  config: ExecutorConfig,
  reqCtx: RequestContext,
): InvocationMeta {
  let userId = 'A2A_USER_' + reqCtx.contextId;
  const sessionId = reqCtx.contextId;

  // A2A SDK attaches auth info to the call context, use it when provided.
  if (reqCtx.context?.user?.userName) {
    userId = reqCtx.context.user.userName;
  }

  const meta: Record<string, unknown> = {
    [toA2aMetaKey('app_name')]: config.runnerConfig.appName,
    [toA2aMetaKey('user_id')]: userId,
    [toA2aMetaKey('session_id')]: sessionId,
  };

  return {
    userId,
    sessionId,
    agentName: config.runnerConfig.agent.name,
    reqCtx,
    eventMeta: meta,
  };
}

export function toEventMeta(
  meta: InvocationMeta,
  event: Event,
): Record<string, unknown> {
  const result: Record<string, unknown> = {...meta.eventMeta};

  const simpleProps: Record<string, string | undefined> = {
    invocation_id: event.invocationId,
    author: event.author,
    branch: event.branch,
  };

  for (const [k, v] of Object.entries(simpleProps)) {
    if (v) {
      result[toA2aMetaKey(k)] = v;
    }
  }

  if (event.groundingMetadata) {
    result[metadataGroundingKey] = event.groundingMetadata;
  }

  if (event.usageMetadata) {
    result[metadataUsageKey] = event.usageMetadata;
  }

  if (event.customMetadata) {
    result[metadataCustomMetaKey] = event.customMetadata;
  }

  if (event.errorCode) {
    result[metadataErrorCodeKey] = event.errorCode;
  }

  return result;
}

export function setActionsMeta(
  meta: Record<string, unknown> | undefined,
  actions: EventActions,
): Record<string, unknown> | undefined {
  if (!actions.transferToAgent && !actions.escalate) {
    return meta;
  }

  const result = meta ? {...meta} : {};

  if (actions.escalate) {
    result[metadataEscalateKey] = true;
  }
  if (actions.transferToAgent) {
    result[metadataTransferToAgentKey] = actions.transferToAgent;
  }

  return result;
}

interface A2aEventInterface {
  metadata?: Record<string, unknown>;
  taskId?: string;
  contextId?: string;
}

export function processA2aMeta(
  a2aEvent: A2aEventInterface,
  event: Event,
): void {
  const meta = a2aEvent.metadata;

  if (meta) {
    if (meta[metadataGroundingKey]) {
      event.groundingMetadata = meta[metadataGroundingKey] as GroundingMetadata;
    }
    if (meta[metadataUsageKey]) {
      event.usageMetadata = meta[
        metadataUsageKey
      ] as GenerateContentResponseUsageMetadata;
    }
  }

  event.customMetadata = toCustomMetadata(
    a2aEvent.taskId || '',
    a2aEvent.contextId || '',
  );

  if (meta) {
    const customMeta = meta[metadataCustomMetaKey] as Record<string, unknown>;
    if (customMeta) {
      if (!event.customMetadata) {
        event.customMetadata = {};
      }
      Object.assign(event.customMetadata, customMeta);
    }

    const errorCode = meta[metadataErrorCodeKey] as string;
    if (errorCode) {
      event.errorCode = errorCode;
    }

    event.actions = toEventActions(meta);
  }
}

export function toEventActions(meta: Record<string, unknown>): EventActions {
  const actions = createEventActions();
  if (meta[metadataEscalateKey]) {
    actions.escalate = true;
  }
  if (meta[metadataTransferToAgentKey]) {
    actions.transferToAgent = meta[metadataTransferToAgentKey] as string;
  }
  return actions;
}

export function toCustomMetadata(
  taskId: string,
  contextId: string,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (taskId) {
    meta[customMetaTaskIdKey] = taskId;
  }
  if (contextId) {
    meta[customMetaContextIdKey] = contextId;
  }
  return meta;
}
