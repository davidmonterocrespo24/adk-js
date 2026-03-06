/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {TaskArtifactUpdateEvent, TaskStatusUpdateEvent} from '@a2a-js/sdk';
import {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
import {RunConfig} from '../agents/run_config.js';
import {Event as AdkEvent} from '../events/event.js';
import {Runner, RunnerConfig} from '../runner/runner.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {Session} from '../sessions/session.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {
  createTask,
  createTaskArtifactUpdateEvent,
  createTaskFailedEvent,
  createTaskWorkingEvent,
} from './a2a_event.js';
import {getFinalTaskStatusUpdate} from './event_processor.js';
import {createExecutorContext, ExecutorContext} from './executor_context.js';
import {handleInputRequired} from './input_required_processor.js';
import {
  getA2AEventMetadata,
  getA2ASessionMetadata,
} from './metadata_converter_utils.js';
import {toA2AParts, toGenAIContent} from './part_converter_utils.js';

/**
 * Callback called before execution starts.
 */
export type BeforeExecuteCallback = (reqCtx: RequestContext) => Promise<void>;

/**
 * Callback called after an ADK event is converted to an A2A event.
 */
export type AfterEventCallback = (
  ctx: ExecutorContext,
  adkEvent: AdkEvent,
  a2aEvent?: TaskArtifactUpdateEvent,
) => Promise<void>;

/**
 * Callback called after execution resolved into a completed or failed task.
 */
export type AfterExecuteCallback = (
  ctx: ExecutorContext,
  finalA2aEvent: TaskStatusUpdateEvent,
  err?: Error,
) => Promise<void>;

/**
 * Configuration for the Executor.
 */
export interface AgentExecutorConfig {
  runnerConfig: RunnerConfig;
  runConfig?: RunConfig;
  beforeExecuteCallback?: BeforeExecuteCallback;
  afterEventCallback?: AfterEventCallback;
  afterExecuteCallback?: AfterExecuteCallback;
}

/**
 * AgentExecutor invokes an ADK agent and translates session events to A2A events.
 */
export class A2AAgentExecutor implements AgentExecutor {
  private agentPartialArtifactIdsMap: Record<string, string> = {};

  constructor(private readonly config: AgentExecutorConfig) {}

  async execute(
    ctx: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const {runnerConfig, runConfig} = this.config;
    const a2aUserMessage = ctx.userMessage;
    if (!a2aUserMessage) {
      throw new Error('message not provided');
    }

    const userId = `A2A_USER_${ctx.contextId}`;
    const sessionId = ctx.contextId;
    const genAIUserMessage = toGenAIContent(a2aUserMessage);
    const session = await getAdkSession(
      userId,
      sessionId,
      runnerConfig.sessionService,
      runnerConfig.appName,
    );
    const executorContext = createExecutorContext({
      session,
      userContent: genAIUserMessage,
      requestContext: ctx,
    });

    try {
      if (this.config.beforeExecuteCallback) {
        await this.config.beforeExecuteCallback(ctx);
      }

      if (ctx.task) {
        const inputRequiredEvent = handleInputRequired(
          ctx.task,
          genAIUserMessage,
        );
        if (inputRequiredEvent) {
          return eventBus.publish(inputRequiredEvent);
        }
      }

      if (!ctx.task) {
        eventBus.publish(
          createTask({
            taskId: ctx.taskId,
            contextId: ctx.contextId,
            message: a2aUserMessage,
          }),
        );
      }

      eventBus.publish(
        createTaskWorkingEvent({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          message: a2aUserMessage,
        }),
      );

      const runner = new Runner(runnerConfig);

      const adkEvents: AdkEvent[] = [];
      for await (const adkEvent of runner.runAsync({
        userId,
        sessionId,
        newMessage: genAIUserMessage,
        runConfig,
      })) {
        adkEvents.push(adkEvent);

        const a2aEvent = this.processAdkEvent(adkEvent, executorContext);
        if (!a2aEvent) {
          continue;
        }

        await this.config.afterEventCallback?.(
          executorContext,
          adkEvent,
          a2aEvent,
        );

        eventBus.publish(a2aEvent);
      }

      const finalA2AExecutionEvent = getFinalTaskStatusUpdate(
        adkEvents,
        executorContext,
      );

      await this.writeFinalTaskStatus(
        executorContext,
        eventBus,
        finalA2AExecutionEvent,
      );
    } catch (err: unknown) {
      const adkErr = err as Error;

      const taskFailedEvent = createTaskFailedEvent({
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        error: new Error(`agent run failed: ${adkErr.message}`),
        metadata: getA2ASessionMetadata({
          appName: runnerConfig.appName,
          userId,
          sessionId,
        }),
      });

      await this.writeFinalTaskStatus(
        executorContext,
        eventBus,
        taskFailedEvent,
        adkErr,
      );
    }
  }

  async cancelTask(_taskId: string): Promise<void> {}

  private processAdkEvent(
    adkEvent: AdkEvent,
    context: ExecutorContext,
  ): TaskArtifactUpdateEvent | undefined {
    const parts = toA2AParts(adkEvent.content?.parts);
    if (parts.length === 0) {
      return undefined;
    }

    const artifactId =
      this.agentPartialArtifactIdsMap[adkEvent.author!] || randomUUID();

    const a2aEvent = createTaskArtifactUpdateEvent({
      taskId: context.requestContext.taskId,
      contextId: context.requestContext.contextId,
      artifactId,
      parts,
      metadata: getA2AEventMetadata(adkEvent, {
        appName: context.agentName,
        userId: context.userId,
        sessionId: context.sessionId,
      }),
      append: adkEvent.partial,
      lastChunk: !adkEvent.partial,
    });

    if (adkEvent.partial) {
      this.agentPartialArtifactIdsMap[adkEvent.author!] = artifactId;
    } else {
      delete this.agentPartialArtifactIdsMap[adkEvent.author!];
    }

    return a2aEvent;
  }

  /**
   * Writes the final status event to the queue.
   */
  private async writeFinalTaskStatus(
    executorContext: ExecutorContext,
    queue: ExecutionEventBus,
    a2aEvent: TaskStatusUpdateEvent,
    error?: Error,
  ): Promise<void> {
    if (this.config.afterExecuteCallback) {
      try {
        await this.config.afterExecuteCallback(
          executorContext,
          a2aEvent,
          error,
        );
      } catch (e: unknown) {
        logger.error('Error in afterExecuteCallback:', e);
      }
    }

    queue.publish(a2aEvent);
  }
}

/**
 * Gets or creates new ADK session.
 */
async function getAdkSession(
  userId: string,
  sessionId: string,
  sessionService: BaseSessionService,
  appName: string,
): Promise<Session> {
  const session = await sessionService.getSession({
    appName,
    userId,
    sessionId,
  });
  if (session) {
    return session;
  }

  return sessionService.createSession({
    appName,
    userId,
    sessionId,
  });
}
