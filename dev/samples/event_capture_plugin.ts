import type {Event, LlmResponse} from '@google/adk';
import {BasePlugin, CallbackContext} from '@google/adk';
import {GenerateContentResponse} from '@google/genai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

function toGenAIResponse(response: LlmResponse): GenerateContentResponse {
  const result = new GenerateContentResponse();

  result.candidates = [
    {
      content: response.content,
      groundingMetadata: response.groundingMetadata,
      finishReason: response.finishReason,
    },
  ];
  result.usageMetadata = response.usageMetadata;

  return result;
}

export class ModelEventCapturePlugin extends BasePlugin {
  private readonly modelResponses: GenerateContentResponse[] = [];

  async afterModelCallback(params: {
    callbackContext: CallbackContext;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    this.modelResponses.push(toGenAIResponse(params.llmResponse));
    return params.llmResponse;
  }

  dump(fileName: string): Promise<void> {
    return fs.writeFile(
      path.join(process.cwd(), fileName),
      JSON.stringify(this.modelResponses, null, 2),
    );
  }
}

export class AgentEventCapturePlugin extends BasePlugin {
  private readonly events: Event[] = [];

  async onEventCallback(params: {event: Event}): Promise<Event | undefined> {
    this.events.push(params.event);
    return params.event;
  }

  dump(fileName: string): Promise<void> {
    return fs.writeFile(
      path.join(process.cwd(), fileName),
      JSON.stringify(this.events, null, 2),
    );
  }
}
