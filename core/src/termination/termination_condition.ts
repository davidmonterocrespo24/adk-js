/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';

/**
 * The result returned by a termination condition when the conversation should
 * stop.
 */
export interface TerminationResult {
  /**
   * A human-readable description of why the conversation was terminated.
   */
  reason: string;
}

/**
 * Abstract base class for all termination conditions.
 *
 * A termination condition is evaluated after each event in the agent loop.
 * When `check()` returns a `TerminationResult`, the loop stops and the
 * `reason` is surfaced in the final event's `actions.terminationReason`.
 *
 * Conditions are stateful but reset automatically at the start of each run.
 * They can be combined with `.and()` and `.or()` to create compound logic.
 *
 * @example
 * ```typescript
 * const condition = new MaxIterationsTermination(10)
 *   .or(new TextMentionTermination('TERMINATE'));
 *
 * const agent = new LoopAgent({ ..., terminationCondition: condition });
 * ```
 */
export abstract class TerminationCondition {
  /**
   * Whether this termination condition has been reached.
   */
  abstract get terminated(): boolean;

  /**
   * Checks whether the termination condition is met given the latest events.
   *
   * Called after each event emitted by the agent. Returns a
   * `TerminationResult` if the loop should stop, or `undefined` to continue.
   *
   * @param events The delta sequence of events since the last check.
   */
  abstract check(events: Event[]): Promise<TerminationResult | undefined>;

  /**
   * Resets this condition to its initial state so it can be reused across
   * multiple runs. Called automatically at the start of each run.
   */
  abstract reset(): Promise<void>;

  /**
   * Returns a new condition that terminates only when BOTH this condition
   * and `other` have been met (logical AND).
   *
   * @param other The other termination condition.
   */
  and(other: TerminationCondition): TerminationCondition {
    return new AndTerminationCondition(this, other);
  }

  /**
   * Returns a new condition that terminates when EITHER this condition or
   * `other` is met first (logical OR).
   *
   * @param other The other termination condition.
   */
  or(other: TerminationCondition): TerminationCondition {
    return new OrTerminationCondition(this, other);
  }
}

/**
 * A compound termination condition that terminates only when ALL of its
 * child conditions have been met (across potentially different events).
 */
export class AndTerminationCondition extends TerminationCondition {
  private _terminated = false;

  constructor(
    private readonly left: TerminationCondition,
    private readonly right: TerminationCondition,
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
    // Forward to both children so each accumulates its own state.
    await this.left.check(events);
    await this.right.check(events);

    if (this.left.terminated && this.right.terminated) {
      this._terminated = true;
      return {
        reason: `All termination conditions met`,
      };
    }

    return undefined;
  }

  async reset(): Promise<void> {
    this._terminated = false;
    await Promise.all([this.left.reset(), this.right.reset()]);
  }
}

/**
 * A compound termination condition that terminates when ANY of its child
 * conditions is met first (logical OR).
 */
export class OrTerminationCondition extends TerminationCondition {
  private _terminated = false;

  constructor(
    private readonly left: TerminationCondition,
    private readonly right: TerminationCondition,
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
    const leftResult = await this.left.check(events);
    if (leftResult) {
      this._terminated = true;
      return leftResult;
    }

    const rightResult = await this.right.check(events);
    if (rightResult) {
      this._terminated = true;
      return rightResult;
    }

    return undefined;
  }

  async reset(): Promise<void> {
    this._terminated = false;
    await Promise.all([this.left.reset(), this.right.reset()]);
  }
}
