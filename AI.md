# AI

`packages/ai` gives the inbox intent detection, priority, thread summaries and
reply drafting. No provider is hard-coded, and the whole surface works offline
with no API key.

## Provider abstraction

```ts
interface AIProvider {
  generateReply(context: ReplyContext): Promise<ReplySuggestion>;
  classifyIntent(context: EmailContext): Promise<IntentResult>;
  summarizeThread(context: EmailContext): Promise<string>;
  editDraft(draft: string, action: string, context: ReplyContext): Promise<ReplySuggestion>;
}
```

| Provider | Notes |
|---|---|
| `local` (default) | rule-based, offline, no key, nothing leaves the machine |
| `openai` | `gpt-4o-mini` by default |
| `anthropic` | `claude-sonnet-4-5` by default |
| `gemini` | `gemini-2.0-flash` by default |
| `groq` | `llama-3.3-70b-versatile` by default |

The four hosted providers share one adapter (`RemoteAIProvider`); only the
endpoint, auth header and request/response shape differ. Adding another —
including a local server exposing an OpenAI-compatible endpoint such as Ollama
— is one entry in the `ENDPOINTS` map.

`getProvider(workspaceId)` resolves the workspace's choice and **falls back to
`local` rather than failing** when external AI is disabled, no key is
configured, or a stored key cannot be decrypted. An AI outage must never stop
the inbox from syncing.

### The local provider is real

It is not a placeholder. It classifies intent from a weighted rule set with
confidence scoring, derives sentiment, priority and a recommended next action,
writes thread summaries, and drafts grounded replies from intent-specific
scaffolds with tone and length adjustment plus all nine editing actions. On a
fresh install every AI feature in the product works immediately, at zero cost.

## Prompt service

All prompt text lives in `prompt.service.ts` — never in a React component,
never in a route handler. Prompts are versioned (`reply-v1`, `intent-v1`,
`summary-v1`, `edit-v1`) and the version is persisted with every result, so any
output can be traced to the exact prompt that produced it.

```ts
buildReplyPrompt({ contact, campaign, thread, latestMessage, style, length, customInstructions })
```

## Guardrails

Stated as hard constraints in the system prompt, because a fabricated price or
invented availability in an outbound sales email is a commercial problem, not a
cosmetic one:

- Use only facts present in the supplied context.
- Never invent pricing, discounts, contract terms or figures.
- Never invent features, integrations, certifications or customers.
- Never promise a capability, timeline or delivery date not in the context.
- Never invent meeting availability.
- Acknowledge and confirm opt-out requests; do not sell.
- Preserve the sender's intent and prior commitments.
- Body text only — no subject line, no markdown fences, no signature block.
- If information is missing, return exactly:
  *"Additional information is required before generating a reliable response."*

The local provider honours these structurally: its pricing scaffold explains
that an accurate figure needs team size rather than inventing a number.

## Reply generation

Styles: `PROFESSIONAL` `FRIENDLY` `CONCISE` `PERSUASIVE` `EXECUTIVE`
`TECHNICAL` `FOLLOW_UP` `THANK_YOU` `MEETING_REQUEST` `PRICING_RESPONSE`
`INFORMATION_REQUEST`.

Lengths: `SHORT` `MEDIUM` `DETAILED`, plus free-text custom instructions
("keep it under 80 words and ask for a meeting next week").

Requesting three variants returns complementary styles — professional, friendly
and concise — so the choice is between genuinely different drafts.

Editing actions: `REGENERATE` `SHORTEN` `EXPAND` `MAKE_PROFESSIONAL`
`MAKE_FRIENDLY` `IMPROVE_GRAMMAR` `MAKE_PERSUASIVE` `REMOVE_SALES_LANGUAGE`
`ADD_MEETING_CTA`. These modify the draft only.

## Classification

Intents: `INTERESTED` `NOT_INTERESTED` `ASKING_PRICING` `ASKING_INFORMATION`
`MEETING_REQUEST` `REQUEST_CALLBACK` `NEEDS_FOLLOWUP` `POSITIVE` `NEGATIVE`
`OUT_OF_OFFICE` `UNSUBSCRIBE` `BOUNCE` `OTHER`.

Sentiment (`POSITIVE`/`NEUTRAL`/`NEGATIVE`) and priority (`HIGH`/`MEDIUM`/`LOW`)
are treated as assistive signals, not facts, and can be overridden manually.
Confidence is stored alongside every classification.

Classification has consequences: `UNSUBSCRIBE` adds the address to the
suppression list and cancels pending follow-ups; `NOT_INTERESTED` and `BOUNCE`
stop the sequence; `OUT_OF_OFFICE` defers the next step instead of counting as
a reply.

## Nothing sends itself

```
Incoming email → AI suggestion → user review → user edit → save draft → user sends
```

`autoGenerateReplies` pre-drafts a reply when a message arrives, but a draft is
all it ever is. Sending requires a person clicking a separate button. Meeting
detection surfaces a "Create calendar event" affordance; it never creates one.

## Cost and privacy control

Settings → AI:

| Control | Effect |
|---|---|
| Analyse scope | `CAMPAIGN_REPLIES` (default) · `UNREAD` · `HIGH_PRIORITY` · `ALL` |
| Intent detection | on/off |
| Thread summaries | on/off |
| AI reply drafting | on/off |
| Pre-generate replies | on/off, default off |
| Allow external AI | off pins the workspace to `local` regardless of other settings |

AI runs on its own queue, so it can never slow down or block inbox
synchronisation.

**What is sent to a hosted provider:** the contact's name, company, title and
industry; the campaign name and sequence step; the messages in that one thread;
and the user's instructions.

**What is never sent:** passwords, cookies, session tokens, authentication
data, browser state, unrelated emails, or personal information beyond the
fields listed above.

API keys are encrypted at rest with AES-256-GCM and never returned to the
frontend — the settings screen shows a masked hint only.

## History

Every generation is stored in `AIReplySuggestion` with its provider, model,
prompt version, style, length and instructions, and whether it was selected,
edited or sent. Nothing is ever overwritten; regenerating adds a row. Any
suggestion can be recalled from the thread's history panel or saved as a
reusable template.
