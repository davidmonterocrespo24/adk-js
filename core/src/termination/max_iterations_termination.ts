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
 * Terminates the conversation after a maximum number of events have been
 * processed.
 *
 * @example
 * ```typescript
 * // Stop after 10 events
 * const condition = new MaxIterationsTermination(10);
 * ```
 */
export class MaxIterationsTermination extends TerminationCondition {
  private _terminated = false;
  private _count = 0;

  /**
   * @param maxIterations The maximum number of events to process before
   *     terminating.
   */
  constructor(private readonly maxIterations: number) {
    super();
    if (maxIterations <= 0) {
      throw new Error('maxIterations must be a positive integer.');
    }
  }

  get terminated(): boolean {
    return this._terminated;
  }

  async check(events: Event[]): Promise<TerminationResult | undefined> {
    if (this._terminated) {
      return undefined;
    }
    this._count += events.length;

    if (this._count >= this.maxIterations) {
      this._terminated = true;
      return {
        reason: `Maximum iterations of ${this.maxIterations} reached, current count: ${this._count}`,
      };
    }

    return undefined;
  }

  async reset(): Promise<void> {
    this._terminated = false;
    this._count = 0;
  }
}
