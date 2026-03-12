/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AndTerminationCondition,
  Event,
  ExternalTermination,
  FunctionCallTermination,
  MaxIterationsTermination,
  OrTerminationCondition,
  TextMentionTermination,
  TimeoutTermination,
  TokenUsageTermination,
} from '@google/adk';
import {
  createPartFromFunctionResponse,
  createPartFromText,
} from '@google/genai';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextEvent(text: string, author = 'agent'): Event {
  return {
    id: 'test-id',
    invocationId: 'inv-1',
    author,
    timestamp: Date.now(),
    actions: {
      stateDelta: {},
      artifactDelta: {},
      requestedAuthConfigs: {},
      requestedToolConfirmations: {},
    },
    content: {
      role: 'model',
      parts: [createPartFromText(text)],
    },
  };
}

function makeTokenEvent(
  totalTokens: number,
  promptTokens: number,
  completionTokens: number,
): Event {
  return {
    id: 'test-id',
    invocationId: 'inv-1',
    author: 'agent',
    timestamp: Date.now(),
    actions: {
      stateDelta: {},
      artifactDelta: {},
      requestedAuthConfigs: {},
      requestedToolConfirmations: {},
    },
    usageMetadata: {
      totalTokenCount: totalTokens,
      promptTokenCount: promptTokens,
      candidatesTokenCount: completionTokens,
    },
  };
}

function makeFunctionResponseEvent(functionName: string): Event {
  return {
    id: 'test-id',
    invocationId: 'inv-1',
    author: 'agent',
    timestamp: Date.now(),
    actions: {
      stateDelta: {},
      artifactDelta: {},
      requestedAuthConfigs: {},
      requestedToolConfirmations: {},
    },
    content: {
      role: 'tool',
      parts: [
        createPartFromFunctionResponse(functionName, functionName, {
          result: 'ok',
        }),
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// MaxIterationsTermination
// ---------------------------------------------------------------------------

describe('MaxIterationsTermination', () => {
  it('should throw if maxIterations is not positive', () => {
    expect(() => new MaxIterationsTermination(0)).toThrow();
    expect(() => new MaxIterationsTermination(-1)).toThrow();
  });

  it('should not terminate before reaching maxIterations', async () => {
    const condition = new MaxIterationsTermination(3);
    const result = await condition.check([makeTextEvent('hello')]);
    expect(result).toBeUndefined();
    expect(condition.terminated).toBe(false);
  });

  it('should terminate when maxIterations is reached', async () => {
    const condition = new MaxIterationsTermination(3);
    await condition.check([makeTextEvent('a'), makeTextEvent('b')]);
    const result = await condition.check([makeTextEvent('c')]);
    expect(result).toBeDefined();
    expect(result!.reason).toContain('3');
    expect(condition.terminated).toBe(true);
  });

  it('should not fire again after termination', async () => {
    const condition = new MaxIterationsTermination(1);
    await condition.check([makeTextEvent('first')]);
    expect(condition.terminated).toBe(true);
    const secondResult = await condition.check([makeTextEvent('second')]);
    expect(secondResult).toBeUndefined();
  });

  it('should reset correctly', async () => {
    const condition = new MaxIterationsTermination(1);
    await condition.check([makeTextEvent('first')]);
    expect(condition.terminated).toBe(true);

    await condition.reset();
    expect(condition.terminated).toBe(false);

    const result = await condition.check([makeTextEvent('first again')]);
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TextMentionTermination
// ---------------------------------------------------------------------------

describe('TextMentionTermination', () => {
  it('should terminate when text is found in any event', async () => {
    const condition = new TextMentionTermination('TERMINATE');
    const result = await condition.check([
      makeTextEvent('Please TERMINATE now.'),
    ]);
    expect(result).toBeDefined();
    expect(result!.reason).toContain('TERMINATE');
    expect(condition.terminated).toBe(true);
  });

  it('should not terminate when text is absent', async () => {
    const condition = new TextMentionTermination('TERMINATE');
    const result = await condition.check([makeTextEvent('Keep going!')]);
    expect(result).toBeUndefined();
    expect(condition.terminated).toBe(false);
  });

  it('should respect the sources filter', async () => {
    const condition = new TextMentionTermination('APPROVE', {
      sources: ['critic'],
    });

    // Wrong source — should NOT fire
    const noFire = await condition.check([makeTextEvent('APPROVE', 'primary')]);
    expect(noFire).toBeUndefined();

    // Correct source — should fire
    const fire = await condition.check([makeTextEvent('APPROVE', 'critic')]);
    expect(fire).toBeDefined();
  });

  it('should reset correctly', async () => {
    const condition = new TextMentionTermination('DONE');
    await condition.check([makeTextEvent('DONE')]);
    expect(condition.terminated).toBe(true);

    await condition.reset();
    expect(condition.terminated).toBe(false);

    const result = await condition.check([makeTextEvent('not done yet')]);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TokenUsageTermination
// ---------------------------------------------------------------------------

describe('TokenUsageTermination', () => {
  it('should throw if no token limit is provided', () => {
    expect(() => new TokenUsageTermination({})).toThrow();
  });

  it('should terminate when total token limit is exceeded', async () => {
    const condition = new TokenUsageTermination({maxTotalTokens: 100});
    const result = await condition.check([makeTokenEvent(101, 50, 51)]);
    expect(result).toBeDefined();
    expect(result!.reason).toContain('totalTokens');
    expect(condition.terminated).toBe(true);
  });

  it('should terminate when prompt token limit is exceeded', async () => {
    const condition = new TokenUsageTermination({maxPromptTokens: 50});
    const result = await condition.check([makeTokenEvent(60, 55, 5)]);
    expect(result).toBeDefined();
    expect(result!.reason).toContain('promptTokens');
  });

  it('should terminate when completion token limit is exceeded', async () => {
    const condition = new TokenUsageTermination({maxCompletionTokens: 30});
    const result = await condition.check([makeTokenEvent(40, 5, 35)]);
    expect(result).toBeDefined();
    expect(result!.reason).toContain('completionTokens');
  });

  it('should accumulate tokens across multiple events', async () => {
    const condition = new TokenUsageTermination({maxTotalTokens: 100});
    await condition.check([makeTokenEvent(60, 40, 20)]);
    expect(condition.terminated).toBe(false);

    const result = await condition.check([makeTokenEvent(50, 30, 20)]);
    expect(result).toBeDefined();
    expect(condition.terminated).toBe(true);
  });

  it('should ignore events without usageMetadata', async () => {
    const condition = new TokenUsageTermination({maxTotalTokens: 10});
    const result = await condition.check([makeTextEvent('no tokens here')]);
    expect(result).toBeUndefined();
    expect(condition.terminated).toBe(false);
  });

  it('should reset correctly', async () => {
    const condition = new TokenUsageTermination({maxTotalTokens: 100});
    await condition.check([makeTokenEvent(200, 100, 100)]);
    expect(condition.terminated).toBe(true);

    await condition.reset();
    expect(condition.terminated).toBe(false);
    const result = await condition.check([makeTokenEvent(50, 30, 20)]);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TimeoutTermination
// ---------------------------------------------------------------------------

describe('TimeoutTermination', () => {
  it('should throw if timeoutSeconds is not positive', () => {
    expect(() => new TimeoutTermination(0)).toThrow();
    expect(() => new TimeoutTermination(-5)).toThrow();
  });

  it('should not terminate before the timeout elapses', async () => {
    const condition = new TimeoutTermination(60);
    const result = await condition.check([makeTextEvent('hello')]);
    expect(result).toBeUndefined();
    expect(condition.terminated).toBe(false);
  });

  it('should terminate once the timeout has elapsed', async () => {
    // Use a very small value so we can wait for it in tests.
    const condition = new TimeoutTermination(0.01); // 10ms
    // Warm up the start time.
    await condition.check([makeTextEvent('trigger start')]);
    // Wait slightly longer than the timeout.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const result = await condition.check([makeTextEvent('after timeout')]);
    expect(result).toBeDefined();
    expect(result!.reason).toContain('Timeout');
    expect(condition.terminated).toBe(true);
  });

  it('should reset the start time on reset()', async () => {
    const condition = new TimeoutTermination(0.01);
    await condition.check([makeTextEvent('start')]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await condition.check([makeTextEvent('fires')]);
    expect(condition.terminated).toBe(true);

    await condition.reset();
    expect(condition.terminated).toBe(false);
    // After reset, a fresh check should start a new timer
    const result = await condition.check([makeTextEvent('fresh start')]);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FunctionCallTermination
// ---------------------------------------------------------------------------

describe('FunctionCallTermination', () => {
  it('should terminate when the named function is executed', async () => {
    const condition = new FunctionCallTermination('approve');
    const result = await condition.check([
      makeFunctionResponseEvent('approve'),
    ]);
    expect(result).toBeDefined();
    expect(result!.reason).toContain('approve');
    expect(condition.terminated).toBe(true);
  });

  it('should not terminate for a different function name', async () => {
    const condition = new FunctionCallTermination('approve');
    const result = await condition.check([makeFunctionResponseEvent('search')]);
    expect(result).toBeUndefined();
    expect(condition.terminated).toBe(false);
  });

  it('should not terminate on text-only events', async () => {
    const condition = new FunctionCallTermination('approve');
    const result = await condition.check([makeTextEvent('approve this')]);
    expect(result).toBeUndefined();
  });

  it('should reset correctly', async () => {
    const condition = new FunctionCallTermination('approve');
    await condition.check([makeFunctionResponseEvent('approve')]);
    expect(condition.terminated).toBe(true);

    await condition.reset();
    expect(condition.terminated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ExternalTermination
// ---------------------------------------------------------------------------

describe('ExternalTermination', () => {
  it('should not terminate before set() is called', async () => {
    const condition = new ExternalTermination();
    const result = await condition.check([makeTextEvent('anything')]);
    expect(result).toBeUndefined();
    expect(condition.terminated).toBe(false);
  });

  it('should terminate immediately after set() is called', async () => {
    const condition = new ExternalTermination();
    condition.set();
    const result = await condition.check([makeTextEvent('anything')]);
    expect(result).toBeDefined();
    expect(result!.reason).toContain('Externally terminated');
    expect(condition.terminated).toBe(true);
  });

  it('should reset correctly', async () => {
    const condition = new ExternalTermination();
    condition.set();
    expect(condition.terminated).toBe(true);

    await condition.reset();
    expect(condition.terminated).toBe(false);
    const result = await condition.check([makeTextEvent('should not fire')]);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Combinators: .or() and .and()
// ---------------------------------------------------------------------------

describe('OrTerminationCondition (.or())', () => {
  it('should terminate when the first condition fires', async () => {
    const condition = new MaxIterationsTermination(1).or(
      new TextMentionTermination('DONE'),
    );
    const result = await condition.check([makeTextEvent('any')]);
    expect(result).toBeDefined();
    expect(condition.terminated).toBe(true);
  });

  it('should terminate when the second condition fires', async () => {
    const condition = new MaxIterationsTermination(100).or(
      new TextMentionTermination('DONE'),
    );
    const result = await condition.check([makeTextEvent('DONE')]);
    expect(result).toBeDefined();
    expect(condition.terminated).toBe(true);
  });

  it('should not terminate when neither condition fires', async () => {
    const condition = new MaxIterationsTermination(100).or(
      new TextMentionTermination('DONE'),
    );
    const result = await condition.check([makeTextEvent('keep going')]);
    expect(result).toBeUndefined();
    expect(condition.terminated).toBe(false);
  });

  it('should reset both children on reset()', async () => {
    const condition = new MaxIterationsTermination(1).or(
      new TextMentionTermination('DONE'),
    );
    await condition.check([makeTextEvent('fires')]);
    expect(condition.terminated).toBe(true);

    await condition.reset();
    expect(condition.terminated).toBe(false);
  });

  it('should be an instance of OrTerminationCondition', () => {
    const condition = new MaxIterationsTermination(1).or(
      new TextMentionTermination('X'),
    );
    expect(condition).toBeInstanceOf(OrTerminationCondition);
  });
});

describe('AndTerminationCondition (.and())', () => {
  it('should not terminate when only the first condition fires', async () => {
    const left = new MaxIterationsTermination(1);
    const condition = left.and(new TextMentionTermination('DONE'));
    // Left fires (count=1), right has not fired
    const result = await condition.check([makeTextEvent('no keyword here')]);
    expect(result).toBeUndefined();
    expect(condition.terminated).toBe(false);
  });

  it('should not terminate when only the second condition fires', async () => {
    const condition = new MaxIterationsTermination(100).and(
      new TextMentionTermination('DONE'),
    );
    const result = await condition.check([makeTextEvent('DONE')]);
    expect(result).toBeUndefined();
    expect(condition.terminated).toBe(false);
  });

  it('should terminate when both conditions have fired', async () => {
    const left = new MaxIterationsTermination(1);
    const right = new TextMentionTermination('DONE');
    const condition = left.and(right);

    // One call: left fires (count hits 1), right fires (text matches)
    const result = await condition.check([makeTextEvent('DONE')]);
    expect(result).toBeDefined();
    expect(condition.terminated).toBe(true);
  });

  it('should reset both children on reset()', async () => {
    const condition = new MaxIterationsTermination(1).and(
      new TextMentionTermination('DONE'),
    );
    await condition.check([makeTextEvent('DONE')]);
    expect(condition.terminated).toBe(true);

    await condition.reset();
    expect(condition.terminated).toBe(false);
  });

  it('should be an instance of AndTerminationCondition', () => {
    const condition = new MaxIterationsTermination(1).and(
      new TextMentionTermination('X'),
    );
    expect(condition).toBeInstanceOf(AndTerminationCondition);
  });
});
