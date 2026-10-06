# Cloudflare AI Gateway Provider Keys

All third-party model requests must go through the configured Cloudflare AI Gateway. The application sends the Gateway authentication token and omits provider authentication headers, so Gateway BYOK injects the provider key stored for the default alias. Provider keys are never submitted through AI settings or forwarded from an application configuration.

Before enabling AI, add a default Provider Key in Cloudflare Dashboard → AI → AI Gateway → the configured gateway → Provider Keys for every provider used by the application. The gateway token used by the Worker must have AI Gateway Run permission.

Built-in provider routes are used for OpenAI, Anthropic, Google AI Studio, DeepSeek, and OpenRouter. OpenCode Go and OpenCode Zen use Cloudflare Custom Providers `opencode-go` and `opencode-zen`, each with `https://opencode.ai` as its upstream base URL. MiMo media uses the Custom Provider `xiaomi-mimo` with `https://api.xiaomimimo.com` as its upstream base URL. Add a default provider key to each custom provider as well.

The generic Custom preset requires its Cloudflare Custom Provider slug in AI settings. Configure that provider and its default key in Cloudflare first. The stored API URL contributes only the request path; the Cloudflare Custom Provider owns the upstream host and secret.

Do not configure the same provider key in the application. Existing encrypted provider keys in older AI configuration versions are ignored by runtime requests; saving a new version strips them from the active configuration. Historical versions remain available for audit and are never used as provider credentials.
