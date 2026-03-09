/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event, stringifyContent} from '../events/event.js';

import {
  TerminationCondition,
  TerminationResult,
} from './termination_condition.js';

/**
 * Terminates the conversation when a specific text string is found in an
 * event's content.
 *
 * @example
 * ```typescript
 * // Stop when any agent says "TERMINATE"
 * const condition = new TextMentionTermination('TERMINATE');
 *
 * // Stop only when the "critic" agent says "APPROVE"
 * const condition = new TextMentionTermination('APPROVE', { sources: ['critic'] });
 * ```
 */
export class TextMentionTermination extends TerminationCondition {
  private _terminated = false;

  /**
   * @param text The text to look for in event content.
   * @param options.sources An optional list of agent names to check. If
   *     omitted, all sources are checked.
   */
  constructor(
    private readonly text: string,
    private readonly options: {sources?: string[]} = {},
  ) {
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
      if (
        this.options.sources &&
        this.options.sources.length > 0 &&
        !this.options.sources.includes(event.author ?? '')
      ) {
        continue;
      }

      if (stringifyContent(event).includes(this.text)) {
        this._terminated = true;
        return {
          reason: `Text '${this.text}' mentioned`,
        };
      }
    }

    return undefined;
  }

  async reset(): Promise<void> {
    this._terminated = false;
  }
}
