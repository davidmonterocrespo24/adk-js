/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';

import {
  TerminationCondition,
  TerminationResult,
} from './termination_condition.js';

/**
 * Terminates the conversation when cumulative token usage exceeds a
 * configured limit. Token usage is read from `event.usageMetadata`, which is
 * present on events that originate from LLM calls.
 *
 * At least one of the token limits must be provided.
 *
 * @example
 * ```typescript
 * // Stop after 10 000 total tokens
 * const condition = new TokenUsageTermination({ maxTotalTokens: 10_000 });
 *
 * // Stop after 5 000 prompt tokens OR 2 000 completion tokens
 * const condition = new TokenUsageTermination({
 *   maxPromptTokens: 5_000,
 *   maxCompletionTokens: 2_000,
 * });
 * ```
 */
export class TokenUsageTermination extends TerminationCondition {
  private _terminated = false;
  private _totalTokens = 0;
  private _promptTokens = 0;
  private _completionTokens = 0;

  /**
   * @param limits The token usage limits to enforce. At least one must be set.
   */
  constructor(
    private readonly limits: {
      maxTotalTokens?: number;
      maxPromptTokens?: number;
      maxCompletionTokens?: number;
    },
  ) {
    super();
    if (
      limits.maxTotalTokens === undefined &&
      limits.maxPromptTokens === undefined &&
      limits.maxCompletionTokens === undefined
    ) {
      throw new Error(
        'At least one of maxTotalTokens, maxPromptTokens, or maxCompletionTokens must be provided.',
      );
    }
  }

  get terminated(): boolean {
    return this._terminated;
  }

  async check(events: Event[]): Promise<TerminationResult | undefined> {
    if (this._terminated) {
      return undefined;
    }

    for (const event of events) {
      if (!event.usageMetadata) {
        continue;
      }

      this._totalTokens += event.usageMetadata.totalTokenCount ?? 0;
      this._promptTokens += event.usageMetadata.promptTokenCount ?? 0;
      this._completionTokens += event.usageMetadata.candidatesTokenCount ?? 0;

      if (
        this.limits.maxTotalTokens !== undefined &&
        this._totalTokens >= this.limits.maxTotalTokens
      ) {
        this._terminated = true;
        return {
          reason: `Token limit exceeded: totalTokens=${this._totalTokens} >= maxTotalTokens=${this.limits.maxTotalTokens}`,
        };
      }

      if (
        this.limits.maxPromptTokens !== undefined &&
        this._promptTokens >= this.limits.maxPromptTokens
      ) {
        this._terminated = true;
        return {
          reason: `Token limit exceeded: promptTokens=${this._promptTokens} >= maxPromptTokens=${this.limits.maxPromptTokens}`,
        };
      }

      if (
        this.limits.maxCompletionTokens !== undefined &&
        this._completionTokens >= this.limits.maxCompletionTokens
      ) {
        this._terminated = true;
        return {
          reason: `Token limit exceeded: completionTokens=${this._completionTokens} >= maxCompletionTokens=${this.limits.maxCompletionTokens}`,
        };
      }
    }

    return undefined;
  }

  async reset(): Promise<void> {
    this._terminated = false;
    this._totalTokens = 0;
    this._promptTokens = 0;
    this._completionTokens = 0;
  }
}
