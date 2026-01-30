/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {AgentTool, LlmAgent} from '@google/adk';
import {ModelEventCapturePlugin} from './event_capture_plugin.js';
import {run} from './runner.ts';

const summaryAgent = new LlmAgent({
  model: 'gemini-2.0-flash',
  name: 'summary_agent',
  instruction:
    'You are an expert summarizer. Please read the following text and provide a concise summary.',
  description: 'Agent to summarize text',
});

export const rootAgent = new LlmAgent({
  name: 'root_agent',
  model: 'gemini-2.5-flash',
  instruction:
    "You are a helpful assistant. When the user provides a text, use the 'summarize' tool to generate a summary. Always forward the user's message exactly as received to the 'summarize' tool, without modifying or summarizing it yourself. Present the response from the tool to the user.",
  tools: [new AgentTool({agent: summaryAgent, skipSummarization: true})],
});

const prompt = `Quantum computing represents a fundamentally different approach to computation, 
leveraging the bizarre principles of quantum mechanics to process information. Unlike classical computers 
that rely on bits representing either 0 or 1, quantum computers use qubits which can exist in a state of superposition - effectively 
being 0, 1, or a combination of both simultaneously. Furthermore, qubits can become entangled, 
meaning their fates are intertwined regardless of distance, allowing for complex correlations. This parallelism and 
interconnectedness grant quantum computers the potential to solve specific types of incredibly complex problems - such 
as drug discovery, materials science, complex system optimization, and breaking certain types of cryptography - far 
faster than even the most powerful classical supercomputers could ever achieve, although the technology is still largely in its developmental stages.
`;

async function main() {
  const modelEventCapturePlugin = new ModelEventCapturePlugin(
    'model-event-capture',
  );
  await run(rootAgent, prompt, [modelEventCapturePlugin]);
  await modelEventCapturePlugin.dump('agent_as_tool.json');
}

main().catch(console.error);
