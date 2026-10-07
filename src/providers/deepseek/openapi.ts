export const DEEPSEEK_MODELS = ['deepseek-default', 'deepseek-reasoner', 'deepseek-expert', 'deepseek-search'] as const;

const errorResponse = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['message', 'type', 'code'],
      properties: {
        message: { type: 'string' },
        type: { type: 'string', examples: ['invalid_request_error', 'rate_limit_exceeded', 'upstream_error'] },
        param: { type: ['string', 'null'] },
        code: { type: ['string', 'integer'], examples: ['invalid_request', 'model_unavailable', 'captcha_required'] },
      },
    },
  },
};

const errorContent = { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } };

const errors = {
  '400': { description: 'Invalid request body.', content: errorContent },
  '401': { description: 'Missing or wrong bearer token (only when GATEWAY_API_KEY is set).', content: errorContent },
  '404': { description: 'The model is not one of the DeepSeek web models.', content: errorContent },
  '429': {
    description: 'DeepSeek rate limited every account. When `error.code` is `captcha_required`, stop automatic retries and complete the verification on chat.deepseek.com.',
    headers: { 'Retry-After': { description: 'Seconds to wait before retrying.', schema: { type: 'integer' } } },
    content: errorContent,
  },
  '502': { description: 'DeepSeek answered with an error or no answer stream.', content: errorContent },
  '503': { description: 'No DeepSeek account is signed in or every account is cooling down.', content: errorContent },
};

const message = {
  type: 'object',
  required: ['role'],
  properties: {
    role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
    content: {
      oneOf: [
        { type: 'string' },
        { type: 'null' },
        {
          type: 'array',
          description: 'Text and image parts. Images are uploaded to DeepSeek as files.',
          items: {
            oneOf: [
              { type: 'object', required: ['type', 'text'], properties: { type: { const: 'text' }, text: { type: 'string' } } },
              {
                type: 'object',
                required: ['type', 'image_url'],
                properties: { type: { const: 'image_url' }, image_url: { type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'https URL or data URL' } } } },
              },
            ],
          },
        },
      ],
    },
    tool_calls: { type: 'array', items: { $ref: '#/components/schemas/ToolCall' } },
    tool_call_id: { type: 'string' },
  },
};

const toolCall = {
  type: 'object',
  required: ['id', 'type', 'function'],
  properties: {
    id: { type: 'string' },
    type: { const: 'function' },
    function: { type: 'object', required: ['name', 'arguments'], properties: { name: { type: 'string' }, arguments: { type: 'string', description: 'JSON-encoded arguments' } } },
  },
};

export function deepSeekOpenApi(serverUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'DeepSeek Web API',
      version: '1.0.0',
      description: 'OpenAI-compatible API in front of chat.deepseek.com, sent through your own signed-in DeepSeek accounts. Part of Switchyard.',
      contact: { url: 'https://github.com/kravchenski/switchyard/issues' },
    },
    servers: [{ url: serverUrl }],
    security: [{}, { bearerAuth: [] }],
    paths: {
      '/models': {
        get: {
          operationId: 'listModels',
          summary: 'List available models',
          description: 'The four DeepSeek web modes: default chat, reasoner (thinking), expert and search.',
          responses: {
            '200': { description: 'Model list.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ModelList' } } } },
            '401': errors['401'],
          },
        },
      },
      '/chat/completions': {
        post: {
          operationId: 'createChatCompletion',
          summary: 'Create a chat completion',
          description: 'OpenAI Chat Completions. Streams with `stream: true`. Tools are emulated in the prompt and returned as `tool_calls`. A conversation stays in one DeepSeek chat when `conversation_id` (or the `x-conversation-id` header) is reused.',
          parameters: [{ name: 'x-conversation-id', in: 'header', required: false, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatCompletionRequest' } } } },
          responses: {
            '200': {
              description: 'A completion, or server-sent `chat.completion.chunk` events when streaming.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ChatCompletion' } },
                'text/event-stream': { schema: { type: 'string' } },
              },
            },
            ...errors,
          },
        },
      },
      '/health': {
        get: {
          operationId: 'health',
          summary: 'Liveness and account status',
          security: [{}],
          responses: {
            '200': { description: 'At least one DeepSeek account is signed in.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } } },
            '503': { description: 'No DeepSeek account is signed in.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } } },
          },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Needed only when GATEWAY_API_KEY is set.' } },
      schemas: {
        ModelList: {
          type: 'object',
          required: ['object', 'data'],
          properties: { object: { const: 'list' }, data: { type: 'array', items: { $ref: '#/components/schemas/ModelObject' } } },
        },
        ModelObject: {
          type: 'object',
          required: ['id', 'object', 'owned_by'],
          properties: { id: { type: 'string', enum: [...DEEPSEEK_MODELS] }, object: { const: 'model' }, created: { type: 'integer' }, owned_by: { type: ['string', 'null'], examples: ['deepseek-web'] } },
        },
        ChatCompletionRequest: {
          type: 'object',
          required: ['messages'],
          properties: {
            model: { type: 'string', enum: [...DEEPSEEK_MODELS], default: 'deepseek-default' },
            messages: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/ChatMessage' } },
            stream: { type: 'boolean', default: false },
            tools: { type: 'array', items: { type: 'object' } },
            conversation_id: { type: 'string' },
          },
        },
        ChatMessage: message,
        ToolCall: toolCall,
        ChatCompletion: {
          type: 'object',
          required: ['id', 'object', 'created', 'model', 'choices'],
          properties: {
            id: { type: 'string' },
            object: { const: 'chat.completion' },
            created: { type: 'integer' },
            model: { type: 'string' },
            choices: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  message: {
                    type: 'object',
                    properties: {
                      role: { const: 'assistant' },
                      content: { type: ['string', 'null'] },
                      reasoning_content: { type: 'string' },
                      tool_calls: { type: 'array', items: { $ref: '#/components/schemas/ToolCall' } },
                    },
                  },
                  finish_reason: { type: 'string', enum: ['stop', 'tool_calls'] },
                },
              },
            },
            x_deepseek_chat_id: { type: 'string', description: 'DeepSeek chat session that holds this conversation.' },
          },
        },
        Health: {
          type: 'object',
          required: ['status', 'service'],
          properties: { status: { type: 'string', enum: ['ok', 'unauthenticated'] }, service: { const: 'deepseek' } },
        },
        ErrorResponse: errorResponse,
      },
    },
  };
}
