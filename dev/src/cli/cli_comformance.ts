import type {Event, Session} from '@google/adk';
import {Content, createUserContent} from '@google/genai';
import diff from 'difflib';
import glob from 'glob';
import * as fs from 'node:fs/promises';
import path from 'path';
import {parse as parseYaml} from 'yaml';
import {AdkApiClient, RunAgentRequest} from '../server/adk_web_client.js';
import {
  isDirectory,
  isFileExists,
  isFolderExists,
} from '../utils/file_utils.js';

interface TestResult {
  category: string;
  name: string;
  success: boolean;
  errorMessage?: string;
}

interface TestCase {
  category: string;
  name: string;
  dir: string;
  testSpec: TestSpec;
}

interface TestSpec {
  description: string;
  agent: string;
  initialState: Record<string, unknown>;
  userMessages: UserMessage[];
}

interface UserMessage {
  text?: string;
  content?: Content;
  stateDelta: Record<string, unknown>;
}

interface ConformanceTestSummary {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  results: TestResult[];
}

interface ComparisonResult {
  success: boolean;
  errorMessage?: string;
}

export enum ConformanceTestMode {
  REPLAY = 'replay',
  RECORD = 'record',
}

/**
 * Options for running conformance tests.
 */
export interface ConformanceTestRunnerOptions {
  testPaths: string[];
  backendUrl?: string;
  apiClient?: AdkApiClient;
  mode: ConformanceTestMode;
  userId?: string;
}

/**
 * Runs conformance tests.
 */
export class ConformanceTestRunner {
  private readonly client: AdkApiClient;
  private readonly testPaths: string[];
  private readonly mode: ConformanceTestMode;
  private readonly userId: string;

  constructor(options: ConformanceTestRunnerOptions) {
    this.client =
      options.apiClient ?? new AdkApiClient({backendUrl: options.backendUrl!});
    this.testPaths = options.testPaths;
    this.mode = options.mode ?? 'replay';
    this.userId = options.userId ?? 'adk_conformance_test_user';
  }

  private async runUserMessages(sessionId: string, testCase: TestCase) {
    const functionCallNameToIdMap: Record<string, string> = {};
    const userMessages = testCase.testSpec.userMessages;

    for (let index = 0; index < userMessages.length; index++) {
      const userMessage = userMessages[index];
      let content: Content;

      if (userMessage.content) {
        content = userMessage.content;

        if (userMessage.content?.parts?.[0].functionResponse?.name) {
          if (
            !functionCallNameToIdMap[
              userMessage.content.parts?.[0].functionResponse.name
            ]
          ) {
            throw new Error(
              `Function response for ${userMessage.content.parts?.[0].functionResponse.name} does not match any pending function call.`,
            );
          }

          content.parts![0].functionResponse!.id =
            functionCallNameToIdMap[
              userMessage.content.parts?.[0].functionResponse.name
            ];
        }
      } else if (userMessage.text) {
        content = createUserContent(userMessage.text);
      } else {
        throw new Error(
          `User message at index ${index} has neither text nor content`,
        );
      }

      const request: RunAgentRequest = {
        appName: testCase.testSpec.agent,
        userId: this.userId,
        sessionId: sessionId,
        newMessage: content,
        streaming: false,
        stateDelta: userMessage.stateDelta,
      };

      for await (const event of this.client.run(request)) {
        if (event.content?.parts?.[0].functionCall) {
          const {name, id} = event.content.parts[0].functionCall;
          if (name && id) {
            functionCallNameToIdMap[name] = id;
          }
        }
      }
    }
  }

  private async validateTestResults(
    sessionId: string,
    testCase: TestCase,
  ): Promise<TestResult> {
    const finalSession = await this.client.getSession({
      appName: testCase.testSpec.agent,
      userId: this.userId,
      sessionId: sessionId,
    });

    if (!finalSession) {
      throw new Error(
        `No final session found for ${testCase.category}/${testCase.name}`,
      );
    }

    const recordedSession = await this.client.getSession({
      appName: testCase.testSpec.agent,
      userId: this.userId,
      sessionId: sessionId,
    });

    if (!recordedSession) {
      throw new Error(
        `No recorded session found for ${testCase.category}/${testCase.name}`,
      );
    }

    const eventsResult = compareEvents(
      finalSession.events,
      recordedSession.events,
    );
    const sessionResult = compareSession(finalSession, recordedSession);

    const success = eventsResult.success && sessionResult.success;
    const errorMessages = [];
    if (!eventsResult.success && eventsResult.errorMessage) {
      errorMessages.push(eventsResult.errorMessage);
    }
    if (!sessionResult.success && sessionResult.errorMessage) {
      errorMessages.push(sessionResult.errorMessage);
    }

    return {
      category: testCase.category,
      name: testCase.name,
      success,
      errorMessage: errorMessages.join('\n'),
    };
  }

  async runTestCaseReplay(testCase: TestCase): Promise<TestResult> {
    try {
      const session = await this.client.createSession({
        appName: testCase.testSpec.agent,
        userId: this.userId,
        state: testCase.testSpec.initialState,
      });

      try {
        await this.runUserMessages(session.id, testCase);
      } catch (e) {
        return {
          category: testCase.category,
          name: testCase.name,
          success: false,
          errorMessage: `Replay verification failed: ${e}`,
        };
      }

      const result = await this.validateTestResults(session.id, testCase);

      // Clean up session
      await this.client.deleteSession({
        appName: testCase.testSpec.agent,
        userId: this.userId,
        sessionId: session.id,
      });

      return result;
    } catch (e) {
      return {
        category: testCase.category,
        name: testCase.name,
        success: false,
        errorMessage: `Test setup failed: ${e}`,
      };
    }
  }

  async runAllTests(): Promise<ConformanceTestSummary> {
    const testCases = await discoverTestCases(this.testPaths, this.mode);
    if (!testCases.length) {
      console.log('No test cases found!');

      return {
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        results: [],
      };
    }

    console.log(
      `Found ${testCases.length} test cases to run in ${this.mode} mode`,
    );

    const results: TestResult[] = [];
    for (const testCase of testCases) {
      console.log(`Running ${testCase.category}/${testCase.name}...`);
      let result: TestResult;

      if (this.mode == 'replay') {
        result = await this.runTestCaseReplay(testCase);
      } else {
        // TODO: Implement live mode
        result = {
          category: testCase.category,
          name: testCase.name,
          success: false,
          errorMessage: 'Live mode not yet implemented',
        };
        results.push(result);
        console.log(result);
      }
    }

    const passed = results.filter((r) => r.success).length;

    return {
      totalTests: results.length,
      passedTests: passed,
      failedTests: results.length - passed,
      results: results,
    };
  }
}

async function discoverTestCases(testPaths: string[], mode: string) {
  const testCases: TestCase[] = [];

  for (const testPath of testPaths) {
    if (!isFolderExists(testPath) || !isDirectory(testPath)) {
      console.error(`Invalid path: ${testPath}`);
      continue;
    }

    const specFiles = glob.sync(`${testPath}/**/*.spec.yaml`);
    for (const specFile of specFiles) {
      const testSpec = await loadTestSpec(specFile);
      const testCaseDir = path.dirname(specFile);
      const category = path.basename(path.dirname(testCaseDir));
      const name = path.basename(testCaseDir);

      if (
        mode === 'replay' &&
        !isFileExists(path.join(testCaseDir, 'generated-recordings.yaml'))
      ) {
        console.error(`No recordings found for ${category}/${name}`);
        continue;
      }

      testCases.push({
        category,
        name,
        dir: testCaseDir,
        testSpec,
      });
    }
  }
  return testCases.sort((a, b) => {
    if (a.category === b.category) {
      return a.name.localeCompare(b.name);
    }

    return a.category.localeCompare(b.category);
  });
}

export async function loadTestSpec(testCaseDir: string): Promise<TestSpec> {
  const specFile = path.join(testCaseDir, 'spec.yaml');
  const specContent = await fs.readFile(specFile, 'utf-8');

  return parseYaml(specContent) as TestSpec;
}

export async function loadRecordedSession(
  testCaseDir: string,
): Promise<Session | undefined> {
  const sessionFile = path.join(testCaseDir, 'generated-session.yaml');
  if (!isFileExists(sessionFile)) {
    console.error(`Failed to parse session file: No session file found`);

    return undefined;
  }

  try {
    const sessionContent = await fs.readFile(sessionFile, 'utf-8');

    return parseYaml(sessionContent) as Session;
  } catch (e: unknown) {
    console.error(`Failed to parse session file: ${(e as Error).message}`);

    return undefined;
  }
}

function getTestSuccessRate(summary: ConformanceTestSummary): number {
  if (summary.totalTests === 0) {
    return 0;
  }
  return (summary.passedTests / summary.totalTests) * 100;
}

function compareEvents(
  actualEvents: Event[],
  recordedEvents: Event[],
): ComparisonResult {
  if (actualEvents.length !== recordedEvents.length) {
    return {
      success: false,
      errorMessage: `Event count mismatch: ${actualEvents.length} vs ${recordedEvents.length}`,
    };
  }

  for (let i = 0; i < actualEvents.length; i++) {
    const actual = actualEvents[i];
    const recorded = recordedEvents[i];
    const result = compareEvent(actual, recorded, i);

    if (!result.success) {
      return result;
    }
  }

  return {
    success: true,
  };
}

function compareEvent(
  actualEvent: Event,
  recordedEvent: Event,
  index: number,
): ComparisonResult {
  const excludedFields = {
    'id': true,
    'timestamp': true,
    'invocation_id': true,
    'long_running_tool_ids': true,
    'content': {
      'parts': {
        '__all__': {
          'thought_signature': true,
          'function_call': {'id': true},
          'function_response': {'id': true},
        },
      },
    },
    'actions': {
      'state_delta': {
        '_adk_recordings_config': true,
        '_adk_replay_config': true,
      },
      'requested_auth_configs': true,
      'requested_tool_confirmations': true,
    },
  };

  const actual = JSON.stringify(pruneValues(actualEvent, excludedFields));
  const recorded = JSON.stringify(pruneValues(recordedEvent, excludedFields));

  if (actual !== recorded) {
    return {
      success: false,
      errorMessage: generateDiff(actual, recorded, `event ${index}`),
    };
  }

  return {
    success: true,
  };
}

function compareSession(
  actualSession: Session,
  recordedSession: Session,
): ComparisonResult {
  const excludedFields = {
    'id': true,
    'last_update_time': true,
    'state': {
      '_adk_recordings_config': true,
      '_adk_replay_config': true,
    },
    'events': true,
  };

  const actual = JSON.stringify(pruneValues(actualSession, excludedFields));
  const recorded = JSON.stringify(pruneValues(recordedSession, excludedFields));

  if (actual !== recorded) {
    return {
      success: false,
      errorMessage: generateDiff(actual, recorded, 'session'),
    };
  }

  return {
    success: true,
  };
}

function pruneValues(obj: unknown, mask: unknown): unknown {
  if (typeof obj !== 'object' || typeof mask !== 'object') {
    return obj;
  }

  const object = obj as Record<string, unknown>;
  const maskObject = mask as Record<string, unknown>;

  for (const key in maskObject) {
    if (maskObject[key] === true && object[key]) {
      delete object[key];
    } else if (
      typeof maskObject[key] === 'object' &&
      typeof object[key] === 'object'
    ) {
      pruneValues(object[key], maskObject[key]);
    }
  }

  return object;
}

function generateDiff(actual: unknown, recorded: unknown, context: string) {
  const actualJson = JSON.stringify(actual, null, 2);
  const recordedJson = JSON.stringify(recorded, null, 2);

  const diffLines = diff.contextDiff(
    actualJson.split('\n'),
    recordedJson.split('\n'),
    {
      fromfile: `recorded ${context}`,
      tofile: `actual ${context}`,
      lineterm: '',
    },
  );

  if (diffLines.length > 0) {
    return `${context} mismatch:\n${diffLines.join('\n')}`;
  }

  return genetateMismatchMessage(context, actualJson, recordedJson);
}

function genetateMismatchMessage(
  context: string,
  actualValue: string,
  recordedValue: string,
): string {
  return `${context} mismatch - \nActual:\n${actualValue}\nRecorded:\n${recordedValue}`;
}

const LINE = '='.repeat(50);

function printTestHeader(mode: string) {
  console.log(LINE);
  console.log(`Running ADK conformance tests in ${mode} mode...`);
  console.log(LINE);
}

export async function runTest(options: ConformanceTestRunnerOptions) {
  printTestHeader(options.mode);

  console.log('Running conformance tests in', options.testPaths);

  const runner = new ConformanceTestRunner(options);
  const summary = await runner.runAllTests();

  printTestSummary(summary);
}

function printTestSummary(summary: ConformanceTestSummary) {
  // Print summary
  console.log('\n' + LINE);
  console.log('CONFORMANCE TEST SUMMARY');
  console.log(LINE);

  if (summary.totalTests == 0) {
    console.log('No tests were run.');
    return;
  }

  console.log(`Total tests: ${summary.totalTests}`);
  console.log(`Passed: ${summary.passedTests}`);

  if (summary.failedTests > 0) {
    console.log(`Failed: ${summary.failedTests}`);
  } else {
    console.log(`Failed: ${summary.failedTests}`);
  }

  console.log(`Success rate: ${getTestSuccessRate(summary)}`);

  // List failed tests
  const failedTests = summary.results.filter((r) => !r.success);
  if (failedTests.length > 0) {
    console.log('\nFailed tests:');

    for (const result of failedTests) {
      printTestResultDetails(result);
    }
  }

  // Exit with error code if any tests failed
  if (summary.failedTests > 0) {
    throw new Error(`${summary.failedTests} test(s) failed`);
  } else {
    console.log('\nAll tests passed! 🎉');
  }
}

function printTestResultDetails(result: TestResult) {
  console.log(`\n✗ ${result.category}/${result.name}\n`);
  if (result.errorMessage) {
    console.log(result.errorMessage);
  }
}
