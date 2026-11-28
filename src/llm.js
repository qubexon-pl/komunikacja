"use strict";

// The model Podavo Voyage talks to for free-text features (the "Zapytaj" box of the city exploration plan).
// The same setup as Podavo Clean (tidy/react/server/llm.ts): one configuration, one client, a strict JSON answer.
// Every setting is read under its VOYAGE_* name first, then under the TIDY_* name Clean uses, so the App Service
// settings of Clean can be copied as they are.
//
//   Microsoft Foundry, Claude (preferred: billed to the Azure subscription, no key needed):
//     *_FOUNDRY_RESOURCE    name of the Foundry resource (…/{resource}.services.ai.azure.com), or
//     *_FOUNDRY_BASE_URL    the full endpoint, e.g. https://{resource}.services.ai.azure.com/anthropic/
//     *_FOUNDRY_DEPLOYMENT  the Claude deployment (default claude-opus-5-5)
//     *_FOUNDRY_API_KEY     optional; empty = the app's managed identity ("Cognitive Services User" role)
//   Azure OpenAI, when no Foundry setting is present:
//     *_AZURE_OPENAI_ENDPOINT, *_AZURE_OPENAI_DEPLOYMENT (required), *_AZURE_OPENAI_API_KEY (optional, else managed identity)
//   OpenAI API: *_OPENAI_API_KEY, *_OPENAI_MODEL (required)
//   Claude API: *_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY (the key the AI sightseeing plan already uses)
//   None: the feature reports itself as off and the rest of the app works as before.

const PREFIXES = ["VOYAGE_", "TIDY_"];

function createLlm({ env = process.env, fetchSource = fetch, anthropic = null } = {}) {
  const get = (name) => {
    for (const p of PREFIXES) { const v = String(env[p + name] || "").trim(); if (v) return v; }
    return "";
  };
  const foundry = () => !!(get("FOUNDRY_RESOURCE") || get("FOUNDRY_BASE_URL"));
  const azure = () => !foundry() && !!get("AZURE_OPENAI_ENDPOINT");
  const openai = () => !foundry() && !azure() && !!get("OPENAI_API_KEY");
  const claudeKey = () => get("ANTHROPIC_API_KEY") || String(env.ANTHROPIC_API_KEY || "").trim();
  const provider = () => (foundry() ? "foundry" : azure() ? "azure-openai" : openai() ? "openai" : claudeKey() ? "claude" : "none");
  const model = () => ({ foundry: get("FOUNDRY_DEPLOYMENT") || "claude-opus-5-5", "azure-openai": get("AZURE_OPENAI_DEPLOYMENT"), openai: get("OPENAI_MODEL") }[provider()] ?? (env.AI_ASK_MODEL || "claude-opus-5-5"));

  let client = anthropic;
  function claudeClient() {
    if (client) return client;
    const common = { timeout: 60000, maxRetries: 1 };
    if (foundry()) {
      const { AnthropicFoundry } = require("@anthropic-ai/foundry-sdk");
      const key = get("FOUNDRY_API_KEY");
      let auth = { apiKey: key };
      if (!key) {
        const { DefaultAzureCredential, getBearerTokenProvider } = require("@azure/identity");
        auth = { azureADTokenProvider: getBearerTokenProvider(new DefaultAzureCredential(), "https://ai.azure.com/.default") };
      }
      client = new AnthropicFoundry({ ...common, ...(get("FOUNDRY_BASE_URL") ? { baseURL: get("FOUNDRY_BASE_URL") } : { resource: get("FOUNDRY_RESOURCE") }), ...auth });
    } else {
      const { default: Anthropic } = require("@anthropic-ai/sdk");
      client = new Anthropic({ ...common, apiKey: claudeKey() });
    }
    return client;
  }

  async function askClaude(ask) {
    const request = {
      model: model(),
      max_tokens: ask.maxTokens || 2048,
      system: ask.system,
      output_config: { effort: ask.effort || "low", format: { type: "json_schema", schema: ask.schema } },
      messages: [{ role: "user", content: ask.user }],
    };
    const options = { timeout: ask.timeoutMs || 60000 };
    // Fallback to another model on a refusal exists only on the Claude API, not on Foundry.
    const c = claudeClient();
    const response = foundry()
      ? await c.messages.create(request, options)
      : await c.beta.messages.create({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, options);
    if (response.stop_reason === "refusal") throw refusal(ask.name);
    const out = (response.content || []).find((b) => b.type === "text");
    if (!out) throw new Error(`${ask.name}: no text (stop_reason ${response.stop_reason})`);
    return JSON.parse(out.text);
  }

  let azureToken = null;
  async function askOpenAI(ask) {
    const headers = { "content-type": "application/json" };
    let url;
    if (provider() === "azure-openai") {
      let base = get("AZURE_OPENAI_ENDPOINT").replace(/\/+$/, "");
      if (!/\/openai\/v1$/.test(base)) base = base.replace(/\/openai$/, "") + "/openai/v1";
      url = `${base}/chat/completions`;
      const key = get("AZURE_OPENAI_API_KEY");
      if (key) headers["api-key"] = key;
      else {
        if (!azureToken) {
          const { DefaultAzureCredential, getBearerTokenProvider } = require("@azure/identity");
          azureToken = getBearerTokenProvider(new DefaultAzureCredential(), "https://cognitiveservices.azure.com/.default");
        }
        headers.authorization = `Bearer ${await azureToken()}`;
      }
    } else {
      url = `${(get("OPENAI_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
      headers.authorization = `Bearer ${get("OPENAI_API_KEY")}`;
    }
    if (!model()) throw new Error(`${ask.name}: set the model or deployment name`);
    const res = await fetchSource(url, {
      method: "POST", headers, signal: AbortSignal.timeout(ask.timeoutMs || 60000),
      body: JSON.stringify({
        model: model(),
        max_completion_tokens: (ask.maxTokens || 2048) * 2, // reasoning models spend part of it on reasoning
        messages: [{ role: "system", content: ask.system }, { role: "user", content: ask.user }],
        response_format: { type: "json_schema", json_schema: { name: ask.name, strict: true, schema: ask.schema } },
      }),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 400 && body?.error?.code === "content_filter") throw refusal(ask.name);
    if (!res.ok) throw new Error(`${ask.name}: HTTP ${res.status} ${body?.error?.message || ""}`.trim());
    const choice = body?.choices?.[0];
    if (choice?.message?.refusal || choice?.finish_reason === "content_filter") throw refusal(ask.name);
    if (typeof choice?.message?.content !== "string") throw new Error(`${ask.name}: no text`);
    return JSON.parse(choice.message.content);
  }

  // Asks the model and parses its JSON answer. A refusal throws an error with .refusal = true.
  async function askJson(ask) {
    const p = provider();
    if (p === "none") throw new Error(`${ask.name}: no model configured`);
    return p === "azure-openai" || p === "openai" ? askOpenAI(ask) : askClaude(ask);
  }
  const label = () => ({ foundry: "Microsoft Foundry (Claude)", "azure-openai": "Azure OpenAI", openai: "OpenAI API", claude: "Claude API", none: "—" })[provider()];
  return { askJson, provider, model, enabled: () => provider() !== "none", label };
}
const refusal = (name) => Object.assign(new Error(`${name}: refusal`), { refusal: true });

module.exports = { createLlm };
