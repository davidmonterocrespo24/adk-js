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
 * Terminates the conversation after a specified duration has elapsed since
 * the first `check()` call (i.e. since the run started).
 *
 * @example
 * ```typescript
 * // Stop after 30 seconds
 * const condition = new TimeoutTermination(30);
 * ```
 */
export class TimeoutTermination extends TerminationCondition {
  private _terminated = false;
  private _startTime: number | undefined = undefined;

  /**
   * @param timeoutSeconds The maximum duration in seconds before the
   *     conversation is terminated.
   */
  constructor(private readonly timeoutSeconds: number) {
    super();
    if (timeoutSeconds <= 0) {
      throw new Error('timeoutSeconds must be a positive number.');
    }
  }

  get terminated(): boolean {
    return this._terminated;
  }

  async check(_events: Event[]): Promise<TerminationResult | undefined> {
    if (this._terminated) {
      return undefined;
    }

    if (this._startTime === undefined) {
      this._startTime = Date.now();
    }

    const elapsedMs = Date.now() - this._startTime;
    const elapsedSeconds = elapsedMs / 1000;

    if (elapsedSeconds >= this.timeoutSeconds) {
      this._terminated = true;
      return {
        reason: `Timeout of ${this.timeoutSeconds}s reached (elapsed: ${elapsedSeconds.toFixed(2)}s)`,
      };
    }

    return undefined;
  }

  async reset(): Promise<void> {
    this._terminated = false;
    this._startTime = undefined;
  }
}
