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
 * A termination condition that is controlled programmatically by calling
 * `set()`. Useful for integrating external stop signals such as a UI
 * "Stop" button or application-level logic.
 *
 * @example
 * ```typescript
 * const stopButton = new ExternalTermination();
 *
 * const agent = new LoopAgent({
 *   ...,
 *   terminationCondition: stopButton,
 * });
 *
 * // Elsewhere (e.g. from a UI event handler):
 * stopButton.set();
 * ```
 */
export class ExternalTermination extends TerminationCondition {
  private _terminated = false;

  get terminated(): boolean {
    return this._terminated;
  }

  /**
   * Signals that the conversation should terminate at the next check.
   */
  set(): void {
    this._terminated = true;
  }

  async check(_events: Event[]): Promise<TerminationResult | undefined> {
    if (this._terminated) {
      return {
        reason: 'Externally terminated',
      };
    }

    return undefined;
  }

  async reset(): Promise<void> {
    this._terminated = false;
  }
}
