import type {MessageSendParams} from '@a2a-js/sdk';
import {ClientFactory} from '@a2a-js/sdk/client';
import {v4 as uuidv4} from 'uuid';

const factory = new ClientFactory();

const client = await factory.createFromUrl(
  'http://localhost:8000/a2a/agent_with_tool/',
);

async function streamTask() {
  const streamParams: MessageSendParams = {
    message: {
      messageId: uuidv4(),
      role: 'user',
      parts: [{kind: 'text', text: 'Hello, what is weather in New York?'}],
      kind: 'message',
    },
  };

  // const response = await client.sendMessage(streamParams);
  // const result = response as Message;
  // console.log('Agent response:', result.parts);

  try {
    const stream = client.sendMessageStream(streamParams);

    for await (const event of stream) {
      if (event.kind === 'task') {
        console.log(
          `[${event.id}] Task created. Status: ${event.status.state}`,
        );
      } else if (event.kind === 'status-update') {
        console.log(`[${event.taskId}] Status Updated: ${event.status.state}`);
      } else if (event.kind === 'artifact-update') {
        console.log(
          `[${event.taskId}] Artifact Received: ${JSON.stringify(event.artifact, null, 2)}`,
        );
      }
    }
    console.log('--- Stream finished ---');
  } catch (error) {
    console.error('Error during streaming:', error);
  }
}

await streamTask();
