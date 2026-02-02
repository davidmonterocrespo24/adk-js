/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  BaseAgent,
  BaseAgentConfig,
  BaseTool,
  BaseToolset,
  isBaseAgent,
  LlmAgent,
  LlmAgentConfig,
  LoopAgent,
  MCPConnectionParams,
  MCPToolset,
  ParallelAgent,
  SequentialAgent,
  SingleAfterModelCallback,
  SingleAfterToolCallback,
  SingleAgentCallback,
  SingleBeforeModelCallback,
  SingleBeforeToolCallback,
  ToolPredicate,
} from '@google/adk';
import {GenerateContentConfig, Schema} from '@google/genai';
import esbuild from 'esbuild';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {parse as parseYaml} from 'yaml';

import {getTempDir, isFile, isFileExists} from './file_utils.js';

const JS_FILES_EXTENSIONST_TO_COMPILE = ['.ts', '.mts'];
const JS_FILES_EXTENSIONS = ['.js', '.cjs', '.mjs', '.ts', '.mts'];

interface FileMetadata {
  path: string;
  name: string;
  ext?: string;
  isFile: boolean;
  isDirectory: boolean;
}

class AgentFileLoadingError extends Error {}

export enum AgentFileBundleMode {
  ANY = 'any',
  TS = 'ts',
}

/**
 * Options for loading an agent file.
 */
export interface AgentFileOptions {
  bundle?: AgentFileBundleMode;
}

export enum AgentClass {
  LLM_AGENT = 'LlmAgent',
  LOOP_AGENT = 'LoopAgent',
  SEQUENTIAL_AGENT = 'SequentialAgent',
  PARALLEL_AGENT = 'ParallelAgent',
}

export interface YamlCodeConfig {
  name: string;
  args?: {name: string; value: string}[];
}

export interface YamSubAgentConfig {
  configPath: string;
}

export interface YamlBaseAgentConfig {
  name: string;
  description?: string;
  subAgents?: YamSubAgentConfig[];
  beforeAgentCallback?: YamlCodeConfig[];
  afterAgentCallback?: YamlCodeConfig[];
}

export interface YamlToolConfig {
  name: string;
  args?: Record<string, string>;
}

export interface YamlLlmAgentConfig extends YamlBaseAgentConfig {
  agentClass: AgentClass.LLM_AGENT;
  model?: string;
  instruction?: string;
  globalInstruction?: string;
  tools?: YamlToolConfig[];
  generateContentConfig?: GenerateContentConfig;
  disallowTransferToParent?: boolean;
  disallowTransferToPeers?: boolean;
  includeContents?: 'default' | 'none';
  inputSchema?: Schema;
  outputSchema?: Schema;
  outputKey?: string;
  beforeModelCallback?: YamlCodeConfig[];
  afterModelCallback?: YamlCodeConfig[];
  beforeToolCallback?: YamlCodeConfig[];
  afterToolCallback?: YamlCodeConfig[];
}

export interface YamlLoopAgentConfig extends YamlBaseAgentConfig {
  agentClass: AgentClass.LOOP_AGENT;
  maxIterations?: number;
}

export interface YamlSequentialAgentConfig extends YamlBaseAgentConfig {
  agentClass: AgentClass.SEQUENTIAL_AGENT;
}

export interface YamlParallelAgentConfig extends YamlBaseAgentConfig {
  agentClass: AgentClass.PARALLEL_AGENT;
}

export type AgentConfig =
  | YamlLlmAgentConfig
  | YamlLoopAgentConfig
  | YamlSequentialAgentConfig
  | YamlParallelAgentConfig;

/**
 * Default options for loading an agent file.
 *
 * Compile and bundle only .ts files.
 */
const DEFAULT_AGENT_FILE_OPTIONS: AgentFileOptions = {
  bundle: AgentFileBundleMode.TS,
};

export abstract class LoadableFile<T = unknown> {
  protected model?: T;
  protected filePath: string;
  protected cleanupFilePath?: string;
  protected disposed = false;
  private children: LoadableFile[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  protected abstract load(): Promise<T>;

  protected markToDispose(file: LoadableFile): void {
    this.children.push(file);
  }

  getFilePath(): string {
    if (!this.model) {
      throw new Error('Agent is not loaded yet');
    }

    if (this.disposed) {
      throw new Error('Agent is disposed and can not be used');
    }

    return this.cleanupFilePath || this.filePath;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    for (const child of this.children) {
      await child.dispose();
    }

    if (this.cleanupFilePath) {
      this.disposed = true;
      return fsPromises.unlink(this.cleanupFilePath);
    }
  }
}

/**
 * Wrapper class which loads file that contains base agent (support both .js and
 * .ts) and has a dispose function to cleanup the comliped artifact after file
 * usage.
 */
export class AgentFile extends LoadableFile<BaseAgent> {
  constructor(
    readonly filePath: string,
    private readonly options = DEFAULT_AGENT_FILE_OPTIONS,
  ) {
    super(filePath);
  }

  async load(): Promise<BaseAgent> {
    if (this.model) {
      return this.model;
    }

    if (!(await isFileExists(this.filePath))) {
      throw new AgentFileLoadingError(
        `Agent file ${this.filePath} does not exists`,
      );
    }

    let filePath = this.filePath;
    const fileExt = path.extname(filePath);

    if (
      this.options.bundle === AgentFileBundleMode.ANY ||
      JS_FILES_EXTENSIONST_TO_COMPILE.includes(fileExt)
    ) {
      const parsedPath = path.parse(filePath);
      const compiledFilePath = path.join(
        getTempDir('adk_agent_loader'),
        parsedPath.name + '.cjs',
      );

      await esbuild.build({
        entryPoints: [filePath],
        outfile: compiledFilePath,
        target: 'node10.4',
        platform: 'node',
        format: 'cjs',
        packages: 'bundle',
        bundle: true,
        minify: true,
        allowOverwrite: true,
      });

      this.cleanupFilePath = compiledFilePath;
      filePath = compiledFilePath;
    }

    const jsModule = await import(filePath);

    if (jsModule) {
      if (isBaseAgent(jsModule.rootAgent)) {
        return (this.model = jsModule.rootAgent);
      }

      if (isBaseAgent(jsModule.default)) {
        return (this.model = jsModule.default);
      }

      const rootAgents = Object.values(jsModule).filter((exportValue) =>
        isBaseAgent(exportValue),
      ) as BaseAgent[];

      if (rootAgents.length > 1) {
        console.warn(
          `Multiple agents found in ${filePath}. Using the ${
            rootAgents[0].name
          } as a root agent.`,
        );
      }

      if (rootAgents.length > 0) {
        return (this.model = rootAgents[0]);
      }
    }

    this.dispose();
    throw new AgentFileLoadingError(
      `Failed to load agent ${
        filePath
      }: No @google/adk BaseAgent class instance found. Please check that file is not empty and it has export of @google/adk BaseAgent class (e.g. LlmAgent) instance.`,
    );
  }
}

type CodeFunction = (...args: unknown[]) => unknown;

export class FunctionCodeFile<T = CodeFunction> extends LoadableFile<T> {
  constructor(
    readonly filePath: string,
    private readonly functionName: string,
    private readonly options = DEFAULT_AGENT_FILE_OPTIONS,
  ) {
    super(filePath);
  }

  async load(): Promise<T> {
    if (this.model) {
      return this.model;
    }

    if (!(await isFileExists(this.filePath))) {
      throw new AgentFileLoadingError(
        `Agent file ${this.filePath} does not exists`,
      );
    }

    let filePath = this.filePath;
    const fileExt = path.extname(filePath);

    if (
      this.options.bundle === AgentFileBundleMode.ANY ||
      JS_FILES_EXTENSIONST_TO_COMPILE.includes(fileExt)
    ) {
      const parsedPath = path.parse(filePath);
      const compiledFilePath = path.join(
        getTempDir('adk_agent_loader'),
        parsedPath.name + '.cjs',
      );

      await esbuild.build({
        entryPoints: [filePath],
        outfile: compiledFilePath,
        target: 'node10.4',
        platform: 'node',
        format: 'cjs',
        packages: 'bundle',
        bundle: true,
        minify: true,
        allowOverwrite: true,
      });

      this.cleanupFilePath = compiledFilePath;
      filePath = compiledFilePath;
    }

    const jsModule = await import(filePath);

    if (jsModule && jsModule[this.functionName]) {
      return (this.model = jsModule[this.functionName]);
    }

    this.dispose();
    throw new AgentFileLoadingError(`Failed to load function from ${filePath}`);
  }
}

export class ToolConfigFile extends LoadableFile<BaseTool | BaseToolset> {
  constructor(
    readonly filePath: string,
    private readonly toolName: string,
    private readonly toolArgs?: Record<string, unknown>,
  ) {
    super(filePath);
  }

  async load(): Promise<BaseTool | BaseToolset> {
    if (this.model) {
      return this.model;
    }

    if (this.toolName === 'AgentTool') {
      if (!this.toolArgs?.agent) {
        throw new AgentFileLoadingError(`AgentTool requires 'agent' argument`);
      }

      const dir = path.dirname(this.filePath);
      const agentFile = new AgentFile(
        path.join(dir, this.toolArgs.agent as string),
      );
      this.markToDispose(agentFile);
      const agent = await agentFile.load();

      return (this.model = new AgentTool({
        agent,
        ...this.toolArgs,
      }));
    }

    if (this.toolName === 'McpToolset' || this.toolName === 'MCPToolset') {
      return (this.model = new MCPToolset(
        this.toolArgs!.connectionParams! as MCPConnectionParams,
        this.toolArgs!.toolFilter as ToolPredicate,
      ));
    }

    // if (this.toolName === 'LongRunningFunctionTool') {
    //   const dir = path.dirname(this.filePath);
    //   const [fileName, name] = (this.toolArgs!.func as string).split('.');
    //   const functionFile = new FunctionCodeFile(path.join(dir, fileName), name);
    //   this.markToDispose(functionFile);
    //   const func = await functionFile.load();

    //   return (this.model = new LongRunningFunctionTool());
    // }

    if (!(await isFileExists(this.filePath))) {
      throw new AgentFileLoadingError(
        `Tool file ${this.filePath} does not exists`,
      );
    }

    let filePath = this.filePath;
    if (this.filePath.endsWith('.ts')) {
      const parsedPath = path.parse(filePath);
      const compiledFilePath = path.join(
        getTempDir('adk_agent_loader'),
        parsedPath.name + '.cjs',
      );

      await esbuild.build({
        entryPoints: [filePath],
        outfile: compiledFilePath,
        target: 'node10.4',
        platform: 'node',
        format: 'cjs',
        packages: 'bundle',
        bundle: true,
        minify: true,
        allowOverwrite: true,
      });

      this.cleanupFilePath = compiledFilePath;
      filePath = compiledFilePath;
    }

    const jsModule = await import(filePath);

    if (jsModule && jsModule[this.toolName]) {
      return (this.model = jsModule[this.toolName]);
    }

    this.dispose();
    throw new AgentFileLoadingError(`Failed to load function from ${filePath}`);
  }
}

export class AgentConfigFile extends LoadableFile<BaseAgent> {
  constructor(readonly filePath: string) {
    super(filePath);
  }

  async load(): Promise<BaseAgent> {
    if (this.model) {
      return this.model;
    }

    if (!(await isFileExists(this.filePath))) {
      throw new AgentFileLoadingError(
        `Agent file ${this.filePath} does not exists`,
      );
    }

    const filePath = this.filePath;
    const fileExt = path.extname(filePath);

    if (fileExt !== '.yaml') {
      throw new AgentFileLoadingError(
        `Agent config file ${this.filePath} must have .yaml extension`,
      );
    }

    const fileContent = await fsPromises.readFile(filePath, {
      encoding: 'utf-8',
    });

    try {
      const agentConfigRaw = parseYaml(fileContent);
      const agentConfig = camelCaseObject(
        agentConfigRaw,
      ) as unknown as AgentConfig;

      return (this.model = await this.resolveAgent(agentConfig));
    } catch (e: unknown) {
      throw new AgentFileLoadingError(
        `Failed to parse agent config file ${this.filePath}: ${(e as Error).message}`,
      );
    }
  }

  private async resolveAgent(yamlAgentConfig: AgentConfig): Promise<BaseAgent> {
    if (!yamlAgentConfig.agentClass) {
      throw new AgentFileLoadingError(
        `Agent config file ${this.filePath} must have agentClass field`,
      );
    }

    if (
      ![
        AgentClass.LLM_AGENT,
        AgentClass.LOOP_AGENT,
        AgentClass.SEQUENTIAL_AGENT,
        AgentClass.PARALLEL_AGENT,
      ].includes(yamlAgentConfig.agentClass)
    ) {
      throw new AgentFileLoadingError(
        `Unknown agent class ${(yamlAgentConfig as {agentClass: string}).agentClass}`,
      );
    }

    const agentConfig: BaseAgentConfig = {
      name: yamlAgentConfig.name,
      description: yamlAgentConfig.description,
      subAgents: [],
      beforeAgentCallback: [],
      afterAgentCallback: [],
    };

    if (yamlAgentConfig.subAgents && yamlAgentConfig.subAgents.length > 0) {
      for (const subAgentConfig of yamlAgentConfig.subAgents) {
        const dir = path.dirname(this.filePath);
        const subAgentConfigFile = new AgentConfigFile(
          path.join(dir, subAgentConfig.configPath),
        );
        this.markToDispose(subAgentConfigFile);
        const subAgent = await subAgentConfigFile.load();

        agentConfig.subAgents!.push(subAgent);
      }
    }

    if (
      yamlAgentConfig.beforeAgentCallback &&
      yamlAgentConfig.beforeAgentCallback.length > 0
    ) {
      for (const beforeAgentCallbackConfig of yamlAgentConfig.beforeAgentCallback) {
        const callback = await this.loadFunction(beforeAgentCallbackConfig);
        (agentConfig.beforeAgentCallback as SingleAgentCallback[]).push(
          callback as SingleAgentCallback,
        );
      }
    }

    if (
      yamlAgentConfig.afterAgentCallback &&
      yamlAgentConfig.afterAgentCallback.length > 0
    ) {
      for (const afterAgentCallbackConfig of yamlAgentConfig.afterAgentCallback) {
        const callback = await this.loadFunction(afterAgentCallbackConfig);
        (agentConfig.afterAgentCallback as SingleAgentCallback[]).push(
          callback as SingleAgentCallback,
        );
      }
    }

    if (yamlAgentConfig.agentClass === AgentClass.SEQUENTIAL_AGENT) {
      return new SequentialAgent(agentConfig);
    }

    if (yamlAgentConfig.agentClass === AgentClass.PARALLEL_AGENT) {
      return new ParallelAgent(agentConfig);
    }

    if (yamlAgentConfig.agentClass === AgentClass.LOOP_AGENT) {
      return new LoopAgent({
        ...agentConfig,
        maxIterations: yamlAgentConfig.maxIterations,
      });
    }

    const llmAgentConfig: LlmAgentConfig = {
      ...agentConfig,
      model: yamlAgentConfig.model,
      instruction: yamlAgentConfig.instruction,
      generateContentConfig: yamlAgentConfig.generateContentConfig,
      disallowTransferToParent: yamlAgentConfig.disallowTransferToParent,
      disallowTransferToPeers: yamlAgentConfig.disallowTransferToPeers,
      includeContents: yamlAgentConfig.includeContents,
      inputSchema: yamlAgentConfig.inputSchema,
      outputSchema: yamlAgentConfig.outputSchema,
      outputKey: yamlAgentConfig.outputKey,
      tools: [],
      beforeModelCallback: [],
      afterModelCallback: [],
      beforeToolCallback: [],
      afterToolCallback: [],
    };

    if (
      yamlAgentConfig.beforeModelCallback &&
      yamlAgentConfig.beforeModelCallback.length > 0
    ) {
      for (const beforeModelCallbackConfig of yamlAgentConfig.beforeModelCallback) {
        const callback = await this.loadFunction(beforeModelCallbackConfig);
        (
          llmAgentConfig.beforeModelCallback as SingleBeforeModelCallback[]
        ).push(callback as SingleBeforeModelCallback);
      }
    }

    if (
      yamlAgentConfig.afterModelCallback &&
      yamlAgentConfig.afterModelCallback.length > 0
    ) {
      for (const afterModelCallbackConfig of yamlAgentConfig.afterModelCallback) {
        const callback = await this.loadFunction(afterModelCallbackConfig);
        (llmAgentConfig.afterModelCallback as SingleAfterModelCallback[]).push(
          callback as SingleAfterModelCallback,
        );
      }
    }

    if (
      yamlAgentConfig.beforeToolCallback &&
      yamlAgentConfig.beforeToolCallback.length > 0
    ) {
      for (const beforeToolCallbackConfig of yamlAgentConfig.beforeToolCallback) {
        const callback = await this.loadFunction(beforeToolCallbackConfig);
        (llmAgentConfig.beforeToolCallback as SingleBeforeToolCallback[]).push(
          callback as SingleBeforeToolCallback,
        );
      }
    }

    if (
      yamlAgentConfig.afterToolCallback &&
      yamlAgentConfig.afterToolCallback.length > 0
    ) {
      for (const afterToolCallbackConfig of yamlAgentConfig.afterToolCallback) {
        const callback = await this.loadFunction(afterToolCallbackConfig);
        (llmAgentConfig.afterToolCallback as SingleAfterToolCallback[]).push(
          callback as SingleAfterToolCallback,
        );
      }
    }

    if (yamlAgentConfig.tools && yamlAgentConfig.tools.length > 0) {
      for (const toolConfig of yamlAgentConfig.tools) {
        const {filePath, functionName} = getCodeFilePathAndFunctionName(
          this.filePath,
          toolConfig.name,
        );
        const toolConfigFile = new ToolConfigFile(
          `${filePath}.ts`,
          functionName,
          toolConfig.args,
        );

        this.markToDispose(toolConfigFile);
        const tool = await toolConfigFile.load();
        llmAgentConfig.tools!.push(tool);
      }
    }

    console.log('llmAgentConfig', JSON.stringify(llmAgentConfig, null, 2));

    return new LlmAgent(llmAgentConfig);
  }

  private async loadFunction(
    codeConfig: YamlCodeConfig,
  ): Promise<CodeFunction> {
    const {filePath, functionName} = getCodeFilePathAndFunctionName(
      this.filePath,
      codeConfig.name,
    );

    const functionCodeFile = new FunctionCodeFile(
      `${filePath}.ts`,
      functionName,
    );
    this.markToDispose(functionCodeFile);

    return functionCodeFile.load();
  }
}

/**
 * Loads all agents from a given directory.
 *
 * The directory structure should be:
 * - agents_dir/{agentName}.[js | ts | mjs | cjs]
 * - agents_dir/{agentName}/agent.[js | ts | mjs | cjs]
 *
 * Agent file should has export of the rootAgent as instance of BaseAgent (e.g
 * LlmAgent).
 */
export class AgentLoader {
  private agentsAlreadyPreloaded = false;
  private readonly preloadedAgents: Record<
    string,
    AgentFile | AgentConfigFile
  > = {};

  constructor(
    private readonly agentsDirPath: string = process.cwd(),
    private readonly options = DEFAULT_AGENT_FILE_OPTIONS,
  ) {
    // Do cleanups on exit
    const exitHandler = async ({
      exit,
      cleanup,
    }: {
      exit?: boolean;
      cleanup?: boolean;
    }) => {
      if (cleanup) {
        await this.disposeAll();
      }

      if (exit) {
        process.exit();
      }
    };

    process.on('exit', () => exitHandler({cleanup: true}));
    process.on('SIGINT', () => exitHandler({exit: true}));
    process.on('SIGUSR1', () => exitHandler({exit: true}));
    process.on('SIGUSR2', () => exitHandler({exit: true}));
    process.on('uncaughtException', () => exitHandler({exit: true}));
  }

  async listAgents(): Promise<string[]> {
    await this.preloadAgents();

    return Object.keys(this.preloadedAgents).sort();
  }

  async getAgentFile(agentName: string): Promise<AgentFile | AgentConfigFile> {
    await this.preloadAgents();

    return this.preloadedAgents[agentName];
  }

  async disposeAll(): Promise<void> {
    await Promise.all(
      Object.values(this.preloadedAgents).map((f) => f.dispose()),
    );
  }

  async preloadAgents() {
    if (this.agentsAlreadyPreloaded) {
      return;
    }

    const files = (await isFile(this.agentsDirPath))
      ? [await getFileMetadata(this.agentsDirPath)]
      : await getDirFiles(this.agentsDirPath);

    await Promise.all(
      files.map(async (fileOrDir: FileMetadata) => {
        if (fileOrDir.isFile) {
          if (isJsFile(fileOrDir.ext)) {
            return this.loadAgentFromFile(fileOrDir);
          }

          if (isConfigFile(fileOrDir.ext)) {
            return this.loadAgentFromConfigFile(fileOrDir);
          }
        }

        if (fileOrDir.isDirectory) {
          return this.loadAgentFromDirectory(fileOrDir);
        }
      }),
    );

    this.agentsAlreadyPreloaded = true;
    return;
  }

  private async loadAgentFromFile(file: FileMetadata): Promise<void> {
    try {
      const agentFile = new AgentFile(file.path, this.options);
      await agentFile.load();
      this.preloadedAgents[file.name] = agentFile;
    } catch (e) {
      if (e instanceof AgentFileLoadingError) {
        console.log('Failed to load agent from file', file.path, e);
        return;
      }
      throw e;
    }
  }

  private async loadAgentFromConfigFile(file: FileMetadata): Promise<void> {
    try {
      const agentFile = new AgentConfigFile(file.path);
      await agentFile.load();
      this.preloadedAgents[file.name] = agentFile;
    } catch (e) {
      if (e instanceof AgentFileLoadingError) {
        console.log('Failed to load agent from config file', file.path, e);
        return;
      }
      throw e;
    }
  }

  private async loadAgentFromDirectory(dir: FileMetadata): Promise<void> {
    const subFiles = await getDirFiles(dir.path);
    const possibleAgentJsFile = subFiles.find(
      (f) => f.isFile && f.name === 'agent' && isJsFile(f.ext),
    );
    const possibleConfigFile = subFiles.find(
      (f) => f.isFile && f.name === 'root_agent' && isConfigFile(f.ext),
    );

    if (!possibleAgentJsFile && !possibleConfigFile) {
      return;
    }

    if (possibleAgentJsFile) {
      try {
        const agentFile = new AgentFile(possibleAgentJsFile.path, this.options);
        await agentFile.load();
        this.preloadedAgents[dir.name] = agentFile;
      } catch (e) {
        if (e instanceof AgentFileLoadingError) {
          console.log(
            'Failed to load agent from file',
            possibleAgentJsFile.path,
            e,
          );
          return;
        }
        throw e;
      }
    }

    if (possibleConfigFile) {
      try {
        console.log('Loading agent from config file', possibleConfigFile.path);
        const agentFile = new AgentConfigFile(possibleConfigFile.path);
        await agentFile.load();
        this.preloadedAgents[dir.name] = agentFile;
      } catch (e) {
        if (e instanceof AgentFileLoadingError) {
          console.log(
            'Failed to load agent from config file',
            possibleConfigFile.path,
            e,
          );
          return;
        }
        throw e;
      }
    }
  }
}

function isJsFile(fileExt?: string): boolean {
  return !!fileExt && JS_FILES_EXTENSIONS.includes(fileExt);
}

function isConfigFile(fileExt?: string): boolean {
  return !!fileExt && fileExt === '.yaml';
}

async function getDirFiles(dir: string): Promise<FileMetadata[]> {
  const files = await fsPromises.readdir(dir);

  return await Promise.all(
    files.map((filePath) => getFileMetadata(path.join(dir, filePath))),
  );
}

async function getFileMetadata(filePath: string): Promise<FileMetadata> {
  const fileStats = await fsPromises.stat(filePath);
  const isFile = fileStats.isFile();
  const baseName = path.basename(filePath);
  const ext = path.extname(filePath);

  return {
    path: filePath,
    name: isFile ? baseName.slice(0, baseName.length - ext.length) : baseName,
    ext: isFile ? path.extname(filePath) : undefined,
    isFile,
    isDirectory: fileStats.isDirectory(),
  };
}

function camelCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function getCodeFilePathAndFunctionName(
  currentPath: string,
  codeConfig: string,
) {
  const dir = path.dirname(currentPath);
  const splitted = codeConfig.split('.');
  const functionName = splitted.pop()!;

  return {
    filePath: path.join(dir, '..', ...splitted),
    functionName,
  };
}

function camelCaseObject(
  obj: Record<string, unknown>,
): Record<string, unknown> | Record<string, unknown>[] {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => camelCaseObject(item)) as Record<
      string,
      unknown
    >[];
  }

  const result: Record<string, unknown> = {};
  for (const key in obj) {
    const value = obj[key];
    result[camelCase(key)] = value;

    if (typeof value === 'object') {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'object') {
            camelCaseObject(item as Record<string, unknown>);
          }
        }
      } else {
        result[camelCase(key)] = camelCaseObject(
          value as Record<string, unknown>,
        );
      }
    }
  }

  return result;
}
