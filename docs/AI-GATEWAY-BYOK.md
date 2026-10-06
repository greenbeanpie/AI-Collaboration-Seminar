# Cloudflare AI Gateway Provider Keys

AI Gateway BYOK applies only to features whose own configuration explicitly uses Cloudflare AI Gateway, such as realtime Google transcription and Gateway-backed speech generation. For those routes, add a default Google Provider Key under Cloudflare Dashboard → AI → AI Gateway → the configured gateway → Provider Keys. The application sends its Gateway authentication token and does not send a Google API key on those requests.

Ordinary AI model settings are independent: their API URL and provider API key are configured in the application settings, and requests go directly to that provider. Gemini media summaries and MiMo media summaries also use their separately configured API URL and encrypted provider key. Configuring a default key in AI Gateway does not change these routes.

Workers AI remains a Cloudflare account service and uses the server-side Cloudflare token plus the configured Gateway ID. Its authentication is separate from third-party Provider Keys.

The realtime Gateway token is an application credential for authorizing requests to Cloudflare AI Gateway. It is not the Google model API key; store it only in the dedicated Gateway token field. Provider keys for Gateway-backed requests stay in Cloudflare and are never submitted in the application form.
