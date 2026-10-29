import * as vscode from 'vscode';
import type { API, GitExtension, Repository } from './git';
import { chat, listModels, ServerConfig } from './llm';

const API_KEY_SECRET = 'hushcommit.apiKey';
const SELECT_MODEL = 'Select model';
const ENTER_MODEL_ID = 'Enter model id';

// Follows Conventional Commits 1.0.0 (https://www.conventionalcommits.org/en/v1.0.0/).
// The spec defines only feat and fix; the other types are the common @commitlint/config-conventional set.
const DEFAULT_INSTRUCTIONS = [
  'Write a git commit message for the staged diff the user sends, following Conventional Commits 1.0.0.',
  'First line: <type>(<scope>): <description>',
  '- type is one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.',
  '  Use feat for a new feature and fix for a bug fix.',
  '- scope is optional: a short noun for the area of the code, e.g. parser. Omit it with its parentheses if unclear.',
  '- description is in the imperative mood and has no trailing period.',
  '- The whole first line is under 72 characters.',
  'Then a blank line, then a short body that explains why the change was made.',
  'If the change breaks backward compatibility, put ! before the colon and end with a footer line',
  '"BREAKING CHANGE: <what breaks>" after another blank line.',
  'Output only the commit message, with no preamble and no code fences.',
].join('\n');

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('hushcommit.generate', (scmArgument?: unknown) =>
      showErrors(() => generate(context, scmArgument)),
    ),
    vscode.commands.registerCommand('hushcommit.selectModel', () => showErrors(() => selectModel(context))),
    vscode.commands.registerCommand('hushcommit.setApiKey', () => showErrors(() => setApiKey(context))),
    vscode.commands.registerCommand('hushcommit.clearApiKey', () => showErrors(() => clearApiKey(context))),
  );
}

export function deactivate(): void {}

async function generate(context: vscode.ExtensionContext, scmArgument: unknown): Promise<void> {
  const config = vscode.workspace.getConfiguration('hushcommit');
  const server = await readServerConfig(context, config);
  if (!server.model) {
    const choice = await vscode.window.showErrorMessage('No model is set (hushcommit.model).', SELECT_MODEL);
    if (choice === SELECT_MODEL) {
      await vscode.commands.executeCommand('hushcommit.selectModel');
    }
    return;
  }

  const repository = await pickRepository(await getGitApi(), scmArgument);
  if (!repository) {
    return;
  }
  let diff = await repository.diff(true);
  if (!diff.trim()) {
    throw new Error('Nothing is staged. Stage the changes you want described, then try again.');
  }
  const maxDiffChars = config.get<number>('maxDiffChars', 40000);
  if (diff.length > maxDiffChars) {
    vscode.window.showWarningMessage(
      `The staged diff is ${diff.length} characters. Only the first ${maxDiffChars} were sent (hushcommit.maxDiffChars).`,
    );
    diff = diff.slice(0, maxDiffChars);
  }

  const instructions = config.get<string>('instructions', '').trim() || DEFAULT_INSTRUCTIONS;
  const options = {
    temperature: config.get<number>('temperature', 0.2),
    maxTokens: config.get<number>('maxTokens', 0),
  };
  const message = await withRequestSignal(config, `Generating commit message with ${server.model}…`, (signal) =>
    chat(
      server,
      options,
      [
        { role: 'system', content: instructions },
        { role: 'user', content: diff },
      ],
      signal,
    ),
  );
  repository.inputBox.value = message;
}

async function selectModel(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('hushcommit');
  const server = await readServerConfig(context, config);
  let modelId: string | undefined;
  try {
    const modelIds = await withRequestSignal(config, 'Listing models…', (signal) => listModels(server, signal));
    if (modelIds.length === 0) {
      throw new Error(`The server at ${server.baseUrl} lists no models.`);
    }
    modelId = await vscode.window.showQuickPick(modelIds, { placeHolder: `Current model: ${server.model || 'not set'}` });
  } catch (error) {
    const choice = await vscode.window.showErrorMessage(errorMessage(error), ENTER_MODEL_ID);
    if (choice !== ENTER_MODEL_ID) {
      return;
    }
    modelId = (await vscode.window.showInputBox({ prompt: 'Model id', value: server.model, ignoreFocusOut: true }))?.trim();
  }
  if (modelId) {
    await config.update('model', modelId, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Commit message model set to ${modelId}.`);
  }
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const apiKey = await vscode.window.showInputBox({
    prompt: 'API key, sent as "Authorization: Bearer <key>". Stored in VS Code SecretStorage, not settings.json.',
    password: true,
    ignoreFocusOut: true,
  });
  if (!apiKey?.trim()) {
    return;
  }
  await context.secrets.store(API_KEY_SECRET, apiKey.trim());
  vscode.window.showInformationMessage('API key saved.');
}

async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(API_KEY_SECRET);
  vscode.window.showInformationMessage('API key cleared.');
}

async function readServerConfig(
  context: vscode.ExtensionContext,
  config: vscode.WorkspaceConfiguration,
): Promise<ServerConfig> {
  return {
    baseUrl: config.get<string>('baseUrl', ''),
    model: config.get<string>('model', '').trim(),
    allowRemote: config.get<boolean>('allowRemote', false),
    apiKey: await context.secrets.get(API_KEY_SECRET),
  };
}

// One AbortController serves both the Cancel button and the timeout; its reason ends up in the error message.
function withRequestSignal<T>(
  config: vscode.WorkspaceConfiguration,
  title: string,
  task: (signal: AbortSignal) => Promise<T>,
): Thenable<T> {
  const timeoutSeconds = config.get<number>('requestTimeoutSeconds', 120);
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (_progress, token) => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error(`timed out after ${timeoutSeconds} s (hushcommit.requestTimeoutSeconds)`)),
        timeoutSeconds * 1000,
      );
      const cancelListener = token.onCancellationRequested(() => controller.abort(new Error('was cancelled')));
      try {
        return await task(controller.signal);
      } finally {
        clearTimeout(timer);
        cancelListener.dispose();
      }
    },
  );
}

async function getGitApi(): Promise<API> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) {
    throw new Error('The built-in Git extension (vscode.git) is not available.');
  }
  const gitExtension = extension.isActive ? extension.exports : await extension.activate();
  return gitExtension.getAPI(1);
}

// The scm/title menu passes the SourceControl, whose rootUri identifies the repository.
async function pickRepository(git: API, scmArgument: unknown): Promise<Repository | undefined> {
  const rootUri = (scmArgument as { rootUri?: unknown } | undefined)?.rootUri;
  if (rootUri instanceof vscode.Uri) {
    const repository = git.getRepository(rootUri);
    if (repository) {
      return repository;
    }
  }
  if (git.repositories.length === 0) {
    throw new Error('No git repository is open.');
  }
  if (git.repositories.length === 1) {
    return git.repositories[0];
  }
  const picked = await vscode.window.showQuickPick(
    git.repositories.map((repository) => ({ label: repository.rootUri.fsPath, repository })),
    { placeHolder: 'Select the repository to write a commit message for' },
  );
  return picked?.repository;
}

async function showErrors(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    vscode.window.showErrorMessage(errorMessage(error));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
