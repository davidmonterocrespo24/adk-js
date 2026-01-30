import {BasePlugin, InMemoryRunner, LlmAgent} from '@google/adk';
import {createUserContent} from '@google/genai';

export async function run(
  agent: LlmAgent,
  prompt: string,
  plugins?: BasePlugin[],
) {
  const userId = 'test_user';
  const appName = agent.name;
  const runner = new InMemoryRunner({agent: agent, appName, plugins});
  const session = await runner.sessionService.createSession({
    appName,
    userId,
  });

  for await (const e of runner.runAsync({
    userId,
    sessionId: session.id,
    newMessage: createUserContent(prompt),
  })) {
    if (e.content?.parts?.[0]?.text) {
      console.log(`${e.author}: ${JSON.stringify(e.content, null, 2)}`);
    }
  }
}
