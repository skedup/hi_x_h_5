import { describe, expect, test } from 'bun:test';
import { publishFailureResult } from './publish.js';

describe('publishFailureResult', () => {
  test('pre-click failures are definite provider failures', () => {
    const result = publishFailureResult('content_input', false);

    expect(result.success).toBe(false);
    expect(result.sideEffectPossible).toBe(false);
    expect(result.error).toContain('content_input');
  });

  test.each(['publish_click', 'outcome'] as const)(
    'failures during %s preserve unknown side-effect semantics',
    (stage) => {
      const result = publishFailureResult(stage, true);

      expect(result.success).toBe(false);
      expect(result.sideEffectPossible).toBe(true);
      expect(result.error).toContain(stage);
    },
  );

  test('failure result cannot expose the upstream error message', () => {
    const result = publishFailureResult('content_input', false);

    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  });
});
