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
import {Event} from '../events/event.js';
import {Runner} from '../runner/runner.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {Session} from '../sessions/session.js';
import {logger} from '../utils/logger.js';
import {
  createTaskFailedEvent,
  createTaskSubmittedEvent,
  createTaskWorkingEvent,
} from './a2a_event.js';
import {EventProcessor} from './event_processor.js';
import {ExecutorContext, createExecutorContext} from './executor_context.js';
import {handleInputRequired} from './input_required_processor.js';
import {toGenAIParts} from './part_converter_utils.js';

export type A2AEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

/**
 * Callback called before execution starts.
 */
export type BeforeExecuteCallback = (reqCtx: RequestContext) => Promise<void>;

/**
 * Callback called after an ADK event is converted to an A2A event.
 */
export type AfterEventCallback = (
  ctx: ExecutorContext,
  event: Event,
  processed?: TaskArtifactUpdateEvent,
) => Promise<void>;

/**
 * Callback called after execution resolved into a completed or failed task.
 */
export type AfterExecuteCallback = (
  ctx: ExecutorContext,
  finalEvent: TaskStatusUpdateEvent,
  err?: Error,
) => Promise<void>;

export type RunnerFactory = (ctx: RequestContext) => Promise<Runner>;

/**
 * Configuration for the Executor.
 */
export interface ExecutorConfig {
  runner: Runner | RunnerFactory;
  agentRunConfig?: RunConfig;
  beforeExecuteCallback?: BeforeExecuteCallback;
  afterExecuteCallback?: AfterExecuteCallback;
  afterEventCallback?: AfterEventCallback;
}

/**
 * AgentExecutor invokes an ADK agent and translates session events to A2A events.
 */
export class A2AAgentExecutor implements AgentExecutor {
  private cancelledTasks = new Set<string>();

  constructor(private readonly config: ExecutorConfig) {}

  async execute(
    ctx: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const {agentRunConfig} = this.config;
    const userMessage = ctx.userMessage;
    const runner = await resolveAdkRunner(this.config.runner, ctx);
    const userId = getUserId(ctx);
    const sessionId = ctx.contextId;
    const content = {
      role: userMessage.role === 'user' ? 'user' : 'model',
      parts: toGenAIParts(userMessage.parts || []),
    };

    const session = await prepareAdkSession(
      userId,
      sessionId,
      runner.sessionService,
      runner.appName,
    );
    const executorContext = createExecutorContext({
      userId,
      agentName: runner.agent.name,
      session,
      userContent: content,
      requestContext: ctx,
    });

    try {
      if (this.config.beforeExecuteCallback) {
        await this.config.beforeExecuteCallback(ctx);
      }

      const inputRequiredEvent = handleInputRequired(ctx, content);
      if (inputRequiredEvent) {
        eventBus.publish(inputRequiredEvent);
        return;
      }

      if (!ctx.task) {
        eventBus.publish(
          createTaskSubmittedEvent({
            taskId: ctx.taskId,
            contextId: ctx.contextId,
            message: userMessage,
          }),
        );
      }

      eventBus.publish(
        createTaskWorkingEvent({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          message: userMessage,
        }),
      );

      const processor = new EventProcessor(ctx);

      try {
        for await (const event of runner.runAsync({
          userId,
          sessionId,
          newMessage: content,
          runConfig: agentRunConfig,
        })) {
          if (event.errorCode || event.errorMessage) {
            const err = new Error(event.errorMessage || event.errorCode);
            const failedEvent = createTaskFailedEvent({
              taskId: ctx.taskId,
              contextId: ctx.contextId,
              error: err,
            });
            await this.writeFinalTaskStatus(
              executorContext,
              eventBus,
              processor.makeFinalArtifactUpdate(),
              failedEvent,
              err,
            );
            return;
          }

          const processed = await processor.process(event);
          if (processed && this.config.afterEventCallback) {
            await this.config.afterEventCallback(
              executorContext,
              event,
              processed,
            );
          }

          if (processed) {
            eventBus.publish(processed);
          }
        }

        const finalStatus = processor.makeFinalStatusUpdate();
        await this.writeFinalTaskStatus(
          executorContext,
          eventBus,
          processor.makeFinalArtifactUpdate(),
          finalStatus,
        );
      } catch (err: unknown) {
        const adkErr = err as Error;
        const event = createTaskFailedEvent({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          error: adkErr,
        });
        await this.writeFinalTaskStatus(
          executorContext,
          eventBus,
          processor.makeFinalArtifactUpdate(),
          event,
          adkErr,
        );
      }
    } catch (err) {
      const adkErr = err as Error;
      const failedEvent = createTaskFailedEvent({
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        error: adkErr,
      });
      await this.writeFinalTaskStatus(
        executorContext,
        eventBus,
        undefined,
        failedEvent,
        adkErr,
      );
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    this.cancelledTasks.add(taskId);
  }

  /**
   * Writes the final status event to the queue.
   */
  private async writeFinalTaskStatus(
    ctx: ExecutorContext,
    queue: ExecutionEventBus,
    partialReset: TaskArtifactUpdateEvent | undefined,
    status: TaskStatusUpdateEvent,
    error?: Error,
  ): Promise<void> {
    if (this.config.afterExecuteCallback) {
      try {
        await this.config.afterExecuteCallback(ctx, status, error);
      } catch (cbErr) {
        logger.error('Error in afterExecuteCallback:', cbErr);
      }
    }

    if (partialReset) {
      queue.publish(partialReset);
    }
    queue.publish(status);
  }
}

async function resolveAdkRunner(
  runnerOrFactory: Runner | RunnerFactory,
  ctx: RequestContext,
): Promise<Runner> {
  if (typeof runnerOrFactory === 'function') {
    return await runnerOrFactory(ctx);
  }

  return runnerOrFactory;
}

/**
 * Prepares the session by ensuring it exists.
 */
async function prepareAdkSession(
  userId: string,
  sessionId: string,
  sessionService: BaseSessionService,
  appName: string,
): Promise<Session> {
  const sessionParams = {
    appName,
    userId,
    sessionId,
  };

  const session = await sessionService.getSession(sessionParams);
  if (!session) {
    return await sessionService.createSession(sessionParams);
  }

  return session;
}

function getUserId(reqCtx: RequestContext): string {
  // A2A SDK attaches auth info to the call context, use it when provided.
  if (reqCtx.context?.user?.userName) {
    return reqCtx.context.user.userName;
  }

  return `A2A_USER_${reqCtx.contextId}`;
}
