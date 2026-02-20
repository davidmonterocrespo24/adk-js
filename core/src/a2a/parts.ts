/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part as A2APart} from '@a2a-js/sdk';
import {Part} from '@google/genai';

const METADATA_TYPE_KEY = 'a2a/type';
const METADATA_LONG_RUNNING_KEY = 'a2a/is_long_running';
const METADATA_THOUGHT_KEY = 'a2a/thought';

const TYPE_FUNCTION_CALL = 'function_call';
const TYPE_FUNCTION_RESPONSE = 'function_response';
const TYPE_CODE_EXEC_RESULT = 'code_execution_result';
const TYPE_CODE_EXECUTABLE_CODE = 'executable_code';

/**
 * Converts a single GenAI Part to an A2A Part.
 */
export function toA2APart(part: Part, longRunningToolIDs?: string[]): A2APart {
  const parts = toA2AParts([part], longRunningToolIDs);
  return parts[0];
}

/**
 * Converts GenAI Parts to A2A Parts.
 */
export function toA2AParts(
  parts: Part[],
  longRunningToolIDs: string[] = [],
): A2APart[] {
  const result: A2APart[] = [];

  for (const part of parts) {
    if (part.text !== undefined && part.text !== null) {
      const a2aPart: A2APart = {kind: 'text', text: part.text};
      // Check for thought property which might exist on internal types
      if ('thought' in part && part['thought']) {
        a2aPart.metadata = {
          [METADATA_THOUGHT_KEY]: true,
        };
      }
      result.push(a2aPart);
    } else if (part.inlineData || part.fileData) {
      const a2aPart = toA2AFilePart(part);
      result.push(a2aPart);
    } else {
      const a2aPart = toA2ADataPart(part, longRunningToolIDs);
      result.push(a2aPart);
    }
  }

  return result;
}

function toA2AFilePart(part: Part): A2APart {
  if (part.fileData) {
    return {
      kind: 'file',
      file: {
        uri: part.fileData.fileUri || '',
        mimeType: part.fileData.mimeType,
      },
      metadata: {},
    };
  }

  if (part.inlineData) {
    return {
      kind: 'file',
      file: {
        bytes: part.inlineData.data || '',
        mimeType: part.inlineData.mimeType,
      },
      metadata: {},
    };
  }

  throw new Error(`Not a file part: ${JSON.stringify(part)}`);
}

function toA2ADataPart(part: Part, longRunningToolIDs: string[]): A2APart {
  let type: string;
  let data: Record<string, unknown>;

  if (part.functionCall) {
    type = TYPE_FUNCTION_CALL;
    data = {functionCall: part.functionCall};
  } else if (part.functionResponse) {
    type = TYPE_FUNCTION_RESPONSE;
    data = {functionResponse: part.functionResponse};
  } else if (part.executableCode) {
    type = TYPE_CODE_EXECUTABLE_CODE;
    data = {executableCode: part.executableCode};
  } else if (part.codeExecutionResult) {
    type = TYPE_CODE_EXEC_RESULT;
    data = {codeExecutionResult: part.codeExecutionResult};
  } else {
    throw new Error(`Unknown part type: ${JSON.stringify(part)}`);
  }

  const metadata: Record<string, unknown> = {
    [METADATA_TYPE_KEY]: type,
  };

  if (
    part.functionCall &&
    part.functionCall.name &&
    longRunningToolIDs.includes(part.functionCall.name)
  ) {
    metadata[METADATA_LONG_RUNNING_KEY] = true;
  }

  if (
    part.functionResponse &&
    part.functionResponse.name &&
    longRunningToolIDs.includes(part.functionResponse.name)
  ) {
    metadata[METADATA_LONG_RUNNING_KEY] = true;
  }

  return {
    kind: 'data',
    data,
    metadata,
  };
}
