// Talks to an OpenAI-compatible server over fetch. No vscode imports, so it can be tested in plain Node.

export interface ServerConfig {
  baseUrl: string;
  model: string;
  allowRemote: boolean;
  apiKey: string | undefined;
}

export interface ChatOptions {
  temperature: number;
  maxTokens: number; // 0 means "don't send max_tokens"
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

// URL.hostname keeps the brackets around IPv6 addresses.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export async function listModels(server: ServerConfig, signal: AbortSignal): Promise<string[]> {
  const { json, where } = await request(server, '/models', undefined, signal);
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || !data.every((entry) => typeof entry?.id === 'string')) {
    throw new Error(`Unexpected response shape from ${where}: expected { data: [{ id }] }.`);
  }
  return data.map((entry) => entry.id as string);
}

export async function chat(
  server: ServerConfig,
  options: ChatOptions,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: server.model,
    messages,
    temperature: options.temperature,
    stream: false,
  };
  if (options.maxTokens > 0) {
    body.max_tokens = options.maxTokens;
  }
  const { json, where } = await request(server, '/chat/completions', body, signal);
  const content = (json as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error(`Unexpected response shape from ${where}: no choices[0].message.content.`);
  }
  const reply = cleanReply(content);
  if (!reply) {
    throw new Error(`The model returned an empty reply from ${where}.`);
  }
  return reply;
}

// Reasoning models wrap their thinking in <think> tags, and many models fence their output.
export function cleanReply(text: string): string {
  const withoutThinking = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = withoutThinking.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return (fenced ? fenced[1] : withoutThinking).trim();
}

export function endpointUrl(server: ServerConfig, path: string): string {
  const url = server.baseUrl.trim().replace(/\/+$/, '') + path;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`localCommitMsg.baseUrl is not a valid URL: "${server.baseUrl}".`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`localCommitMsg.baseUrl must start with http:// or https://, got "${server.baseUrl}".`);
  }
  if (!server.allowRemote && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Refusing to send your staged diff to ${parsed.host}: it is not this machine (localhost, 127.0.0.1 or ::1). ` +
        'If you trust that server, enable the localCommitMsg.allowRemote setting.',
    );
  }
  return url;
}

async function request(
  server: ServerConfig,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<{ json: unknown; where: string }> {
  const url = endpointUrl(server, path);
  const where = `${url} (model: ${server.model || 'not set'})`;
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (server.apiKey) {
    headers.Authorization = `Bearer ${server.apiKey}`;
  }

  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    text = await response.text();
  } catch (error) {
    if (signal.aborted) {
      const reason = signal.reason instanceof Error ? signal.reason.message : 'was aborted';
      throw new Error(`Request to ${where} ${reason}.`);
    }
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code === 'ECONNREFUSED') {
      throw new Error(`Connection refused by ${where}. Is the server running?`);
    }
    throw new Error(`Could not reach ${where}: ${cause?.code ?? cause?.message ?? (error as Error).message}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from ${where}: ${text.slice(0, 300)}`);
  }
  try {
    return { json: JSON.parse(text), where };
  } catch {
    throw new Error(`Response from ${where} is not JSON: ${text.slice(0, 300)}`);
  }
}
