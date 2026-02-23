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
import {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
import {Content, Part} from '@google/genai';
import {RunConfig} from '../agents/run_config.js';
import {Event} from '../events/event.js';
import {Runner, RunnerConfig} from '../runner/runner.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {Session} from '../sessions/session.js';
import {logger} from '../utils/logger.js';
import {ExecutorContext, createExecutorContext} from './executor_context.js';
import {handleInputRequired} from './input_required_processor.js';
import {toInvocationMeta} from './metadata.js';
import {toGenAIParts} from './part_converter_utils.js';
import {EventProcessor} from './processor.js';

export type A2AEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

/**
 * A2APartConverter is a custom converter for converting A2A parts to GenAI parts.
 */
export type A2APartConverter = (
  ctx: RequestContext,
  a2aEvent: A2AEvent,
  part: A2APart,
) => Promise<Part | undefined>;

/**
 * GenAIPartConverter is a custom converter for converting GenAI parts to A2A parts.
 */
export type GenAIPartConverter = (
  ctx: ExecutorContext,
  adkEvent: Event,
  part: Part,
) => Promise<A2APart | undefined>;

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

/**
 * Configuration for the Executor.
 */
export interface ExecutorConfig {
  runnerConfig: RunnerConfig;
  runConfig?: RunConfig;
  beforeExecuteCallback?: BeforeExecuteCallback;
  afterEventCallback?: AfterEventCallback;
  afterExecuteCallback?: AfterExecuteCallback;
  a2aPartConverter?: A2APartConverter;
  genAIPartConverter?: GenAIPartConverter;
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
    const {runnerConfig, runConfig} = this.config;

    const userMessage = ctx.userMessage;
    if (!userMessage) {
      throw new Error('message not provided');
    }

    const invocationMeta = toInvocationMeta(this.config, ctx);
    const userId = invocationMeta.userId;
    const sessionId = invocationMeta.sessionId;

    const content = await toGenAIContent(
      ctx,
      userMessage,
      this.config.a2aPartConverter,
    );

    let executorContext = createExecutorContext({
      userId,
      agentName: runnerConfig.agent.name,
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
        const submittedEvent: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          final: false,
          status: {state: 'submitted', message: userMessage},
        };
        eventBus.publish(submittedEvent);
      }

      const session = await prepareSession(
        executorContext,
        runnerConfig.sessionService,
        runnerConfig.appName,
      );

      executorContext = createExecutorContext({
        userId,
        agentName: runnerConfig.agent.name,
        session,
        userContent: content,
        requestContext: ctx,
      });

      const workingEvent: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        metadata: invocationMeta.eventMeta,
        final: false,
        status: {state: 'working'},
      };
      eventBus.publish(workingEvent);

      const runner = new Runner(runnerConfig);
      const processor = new EventProcessor(ctx);

      try {
        for await (const event of runner.runAsync({
          userId,
          sessionId,
          newMessage: content,
          runConfig: runConfig,
        })) {
          if (event.errorCode || event.errorMessage) {
            const err = new Error(event.errorMessage || event.errorCode);
            const failedEvent = processor.makeTaskFailedEvent(err, event);
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
        const event = processor.makeTaskFailedEvent(
          new Error(`agent run failed: ${adkErr.message}`),
        );
        await this.writeFinalTaskStatus(
          executorContext,
          eventBus,
          processor.makeFinalArtifactUpdate(),
          event,
          adkErr,
        );
      }
    } catch (err) {
      const initErr = err as Error;
      const failedEvent: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        status: {state: 'failed'},
        metadata: invocationMeta.eventMeta
          ? {...invocationMeta.eventMeta, error: initErr.message}
          : {error: initErr.message},
        final: true,
      };
      await this.writeFinalTaskStatus(
        executorContext,
        eventBus,
        undefined,
        failedEvent,
        initErr,
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

/**
 * Prepares the session by ensuring it exists.
 */
async function prepareSession(
  ctx: ExecutorContext,
  sessionService: BaseSessionService,
  appName: string,
): Promise<Session> {
  let session = await sessionService.getSession({
    appName,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
  });

  if (!session) {
    session = await sessionService.createSession({
      appName,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
    });
  }
  return session;
}

/**
 * Converts an A2A Message to GenAI Content.
 */
async function toGenAIContent(
  ctx: RequestContext,
  msg: Message,
  converter?: A2APartConverter,
): Promise<Content> {
  let parts: Part[] = [];
  if (msg.parts) {
    if (converter) {
      for (const p of msg.parts) {
        // Here we pass the message as an A2AEvent since it implements sufficient fields in the context of conversion
        const converted = await converter(ctx, msg as unknown as A2AEvent, p);
        if (converted) {
          parts.push(converted);
        }
      }
    } else {
      parts = await toGenAIParts(msg.parts);
    }
  }

  return {
    role: msg.role === 'user' ? 'user' : 'model',
    parts,
  };
}
