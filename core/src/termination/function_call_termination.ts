/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event, getFunctionResponses} from '../events/event.js';

import {
  TerminationCondition,
  TerminationResult,
} from './termination_condition.js';

/**
 * Terminates the conversation when a tool (function) with a specific name has
 * been executed. The condition checks `FunctionResponse` parts in events.
 *
 * @example
 * ```typescript
 * // Stop when the "approve" tool is called
 * const condition = new FunctionCallTermination('approve');
 * ```
 */
export class FunctionCallTermination extends TerminationCondition {
  private _terminated = false;

  /**
   * @param functionName The name of the function whose execution triggers
   *     termination.
   */
  constructor(private readonly functionName: string) {
    super();
  }

  get terminated(): boolean {
    return this._terminated;
  }

  async check(events: Event[]): Promise<TerminationResult | undefined> {
    if (this._terminated) {
      return undefined;
    }

    for (const event of events) {
      for (const response of getFunctionResponses(event)) {
        if (response.name === this.functionName) {
          this._terminated = true;
          return {
            reason: `Function '${this.functionName}' was executed`,
          };
        }
      }
    }

    return undefined;
  }

  async reset(): Promise<void> {
    this._terminated = false;
  }
}
