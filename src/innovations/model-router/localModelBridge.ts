/**
 * Hybrid Local/Cloud Model Routing - Local Model Bridge
 *
 * Bridges local inference servers (Ollama, llama.cpp, OpenAI-compatible)
 * to the Anthropic streaming format used throughout the codebase.
 * Handles health checks, format conversion, timeouts, and latency tracking.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LocalApiFormat = 'openai' | 'ollama' | 'llama.cpp'

export type LocalModelConfig = {
  /** Base URL of the local inference server */
  endpoint: string
  /** Model name/tag to request */
  model: string
  /** Which API format the server speaks */
  apiFormat: LocalApiFormat
  /** Request timeout in ms (default: 30000) */
  timeoutMs?: number
  /** Maximum retries on transient failure (default: 1) */
  maxRetries?: number
}

/**
 * Simplified stream event that mirrors the shape consumers expect from
 * the Anthropic SDK's BetaRawMessageStreamEvent. We only emit the
 * subset needed for text streaming; callers that need tool_use or other
 * block types should go through the cloud path.
 */
export type StreamEvent =
  | { type: 'message_start'; message: { id: string; model: string; role: 'assistant' } }
  | { type: 'content_block_start'; index: number; content_block: { type: 'text'; text: string } }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: 'end_turn' | 'max_tokens' } }
  | { type: 'message_stop' }

/** OpenAI-compatible chat message */
type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** OpenAI-compatible SSE chunk (subset we care about) */
type OpenAIStreamChunk = {
  id: string
  choices: Array<{
    delta: { content?: string; role?: string }
    finish_reason: string | null
  }>
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export class LocalModelBridge {
  private config: Required<LocalModelConfig>
  private latencyHistory: number[] = []
  private static readonly MAX_LATENCY_SAMPLES = 20

  constructor(config: LocalModelConfig) {
    this.config = {
      endpoint: config.endpoint.replace(/\/+$/, ''),
      model: config.model,
      apiFormat: config.apiFormat,
      timeoutMs: config.timeoutMs ?? 30_000,
      maxRetries: config.maxRetries ?? 1,
    }
  }

  // -----------------------------------------------------------------------
  // Health check
  // -----------------------------------------------------------------------

  /**
   * Returns true if the local model server is reachable and responsive.
   * Uses a lightweight endpoint (models list or health) so it doesn't
   * trigger inference.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const url = this.healthUrl()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      try {
        const res = await fetch(url, { signal: controller.signal })
        return res.ok
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return false
    }
  }

  // -----------------------------------------------------------------------
  // Query (streaming)
  // -----------------------------------------------------------------------

  /**
   * Send messages to the local model and yield StreamEvents that match
   * the Anthropic streaming shape. Automatically retries once on
   * transient network errors.
   */
  async *query(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options?: { maxTokens?: number; temperature?: number; systemPrompt?: string },
  ): AsyncGenerator<StreamEvent> {
    const start = Date.now()
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        yield* this.doQuery(messages, options)
        this.recordLatency(Date.now() - start)
        return
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        // Only retry on network-level errors, not 4xx
        if (!this.isRetryable(lastError)) break
      }
    }

    throw new LocalModelError(
      `Local model query failed after ${this.config.maxRetries + 1} attempt(s): ${lastError?.message}`,
      lastError,
    )
  }

  // -----------------------------------------------------------------------
  // Latency estimation
  // -----------------------------------------------------------------------

  /**
   * Estimated latency in ms based on recent queries.
   * Returns the configured default if no history is available.
   */
  estimateLatency(): number {
    if (this.latencyHistory.length === 0) {
      // Reasonable defaults per format
      return this.config.apiFormat === 'ollama' ? 200 : 150
    }
    const sum = this.latencyHistory.reduce((a, b) => a + b, 0)
    return Math.round(sum / this.latencyHistory.length)
  }

  // -----------------------------------------------------------------------
  // Internal: actual streaming implementation
  // -----------------------------------------------------------------------

  private async *doQuery(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options?: { maxTokens?: number; temperature?: number; systemPrompt?: string },
  ): AsyncGenerator<StreamEvent> {
    const { url, body, headers } = this.buildRequest(messages, options)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      throw err
    }

    if (!response.ok) {
      clearTimeout(timer)
      const text = await response.text().catch(() => '')
      throw new LocalModelError(
        `Local model returned ${response.status}: ${text}`,
      )
    }

    const messageId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Emit message_start
    yield {
      type: 'message_start',
      message: { id: messageId, model: this.config.model, role: 'assistant' },
    }
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }

    try {
      if (this.config.apiFormat === 'ollama') {
        yield* this.parseOllamaStream(response)
      } else {
        // openai and llama.cpp both use SSE with the OpenAI format
        yield* this.parseOpenAIStream(response)
      }
    } finally {
      clearTimeout(timer)
    }

    yield { type: 'content_block_stop', index: 0 }
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    yield { type: 'message_stop' }
  }

  // -----------------------------------------------------------------------
  // Request building
  // -----------------------------------------------------------------------

  private buildRequest(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options?: { maxTokens?: number; temperature?: number; systemPrompt?: string },
  ): { url: string; body: Record<string, unknown>; headers: Record<string, string> } {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    const chatMessages: OpenAIChatMessage[] = []
    if (options?.systemPrompt) {
      chatMessages.push({ role: 'system', content: options.systemPrompt })
    }
    chatMessages.push(...messages)

    if (this.config.apiFormat === 'ollama') {
      return {
        url: `${this.config.endpoint}/api/chat`,
        headers,
        body: {
          model: this.config.model,
          messages: chatMessages,
          stream: true,
          options: {
            num_predict: options?.maxTokens ?? 4096,
            temperature: options?.temperature ?? 0.7,
          },
        },
      }
    }

    // OpenAI-compatible (covers llama.cpp /v1/chat/completions too)
    return {
      url: `${this.config.endpoint}/v1/chat/completions`,
      headers,
      body: {
        model: this.config.model,
        messages: chatMessages,
        max_tokens: options?.maxTokens ?? 4096,
        temperature: options?.temperature ?? 0.7,
        stream: true,
      },
    }
  }

  // -----------------------------------------------------------------------
  // Stream parsers
  // -----------------------------------------------------------------------

  /**
   * Parse an OpenAI-compatible SSE stream (used by vLLM, llama.cpp,
   * LM Studio, LocalAI, etc.).
   */
  private async *parseOpenAIStream(
    response: Response,
  ): AsyncGenerator<StreamEvent> {
    const reader = response.body?.getReader()
    if (!reader) return

    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') return

          let chunk: OpenAIStreamChunk
          try {
            chunk = JSON.parse(data)
          } catch {
            continue
          }

          const content = chunk.choices?.[0]?.delta?.content
          if (content) {
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: content },
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /**
   * Parse an Ollama streaming response (NDJSON, not SSE).
   */
  private async *parseOllamaStream(
    response: Response,
  ): AsyncGenerator<StreamEvent> {
    const reader = response.body?.getReader()
    if (!reader) return

    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          let parsed: { message?: { content?: string }; done?: boolean }
          try {
            parsed = JSON.parse(line)
          } catch {
            continue
          }

          if (parsed.message?.content) {
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: parsed.message.content },
            }
          }

          if (parsed.done) return
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private healthUrl(): string {
    switch (this.config.apiFormat) {
      case 'ollama':
        return `${this.config.endpoint}/api/tags`
      case 'openai':
      case 'llama.cpp':
        return `${this.config.endpoint}/v1/models`
    }
  }

  private isRetryable(err: Error): boolean {
    const msg = err.message.toLowerCase()
    return (
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('fetch failed') ||
      msg.includes('network')
    )
  }

  private recordLatency(ms: number): void {
    this.latencyHistory.push(ms)
    if (this.latencyHistory.length > LocalModelBridge.MAX_LATENCY_SAMPLES) {
      this.latencyHistory.shift()
    }
  }
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class LocalModelError extends Error {
  readonly cause?: Error

  constructor(message: string, cause?: Error) {
    super(message)
    this.name = 'LocalModelError'
    this.cause = cause
  }
}
