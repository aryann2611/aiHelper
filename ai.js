// AI calls for the live assistant, AI notes, Ask AI, mock interviews and PDF import.
// AI_PROVIDER in .env picks the provider: openai and gemini use the OpenAI SDK, claude uses Anthropic's.
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');

const PROVIDERS = {
  claude: {
    name: 'Claude', keyVar: 'ANTHROPIC_API_KEY', sdk: 'anthropic', pdfModel: 'claude-opus-5-5',
    models: [['claude-opus-5-5', 'Claude Opus 5.5 (best answers)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (balanced)'], ['claude-haiku-4-5', 'Claude Haiku 4.5 (fastest)']],
  },
  openai: {
    name: 'OpenAI', keyVar: 'OPENAI_API_KEY', pdfModel: 'gpt-5.4-mini', audioModel: 'gpt-4o-mini-transcribe',
    models: [['gpt-5.5', 'GPT-5.5 (best answers)'], ['gpt-5.4-mini', 'GPT-5.4 mini (balanced)'], ['gpt-5.4-nano', 'GPT-5.4 nano (fastest)']],
  },
  gemini: {
    name: 'Google Gemini', keyVar: 'GEMINI_API_KEY', pdfModel: 'gemini-3.5-flash-lite', audioModel: 'gemini-3.5-flash-lite',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    // Free-plan models that answered in testing; the 2.5 models are closed to new users and Pro isn't free.
    models: [['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite (fast, free)'], ['gemini-3.5-flash', 'Gemini 3.5 Flash (smarter, sometimes busy)']],
  },
};
const provider = PROVIDERS[process.env.AI_PROVIDER] ?? PROVIDERS.openai;
// Claude can't listen to audio, so with Claude the meeting is written down by Gemini (or OpenAI) if that key is there.
const hearing = provider.sdk !== 'anthropic' ? provider : process.env.GEMINI_API_KEY ? PROVIDERS.gemini : PROVIDERS.openai;

const clients = new Map();
function getClient(p = provider) {
  const apiKey = process.env[p.keyVar];
  if (!apiKey) throw new OpenAI.OpenAIError(`${p.keyVar} is missing`); // never fall back to another provider's key
  if (!clients.has(p)) clients.set(p, p.sdk === 'anthropic' ? new Anthropic({ apiKey, timeout: 60e3 }) : new OpenAI({ apiKey, baseURL: p.baseURL, timeout: 60e3 }));
  return clients.get(p);
}
const hasCredentials = () => !!process.env[provider.keyVar];

// All offered models reason before answering; "low" effort keeps replies fast and is supported by each.
const request = ({ model, system, messages, maxTokens }) => ({
  model,
  max_completion_tokens: maxTokens,
  reasoning_effort: 'low',
  messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
});

// Claude: same prompts, converted to the Messages API. Images and PDFs arrive as data URLs.
function toClaudePart(p) {
  if (p.type === 'text') return p;
  const [, mediaType, data] = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url?.url ?? p.file?.file_data ?? '') ?? [];
  return mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: mediaType, data } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}
function claudeRequest({ model, effort = 'low', system, messages, maxTokens }) {
  const body = { model, max_tokens: maxTokens, messages: messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(toClaudePart) })) };
  if (system) body.system = system;
  if (model !== 'claude-haiku-4-5') {
    body.output_config = { effort };              // Opus 5.5 / Sonnet 5.5 think adaptively; effort sets how much
    body.betas = ['server-side-fallback-2026-07-01'];
    body.fallbacks = 'default';                   // a declined request is re-run on Anthropic's recommended fallback model
  }
  return body;
}
async function askClaude(opts, emit, signal) {
  const stream = getClient().beta.messages.stream(claudeRequest(opts), { signal });
  for await (const ev of stream) if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') emit(ev.delta.text);
  const msg = await stream.finalMessage();
  return msg.stop_reason === 'refusal' ? 'content_filter' : msg.stop_reason === 'max_tokens' ? 'length' : null;
}

// Streams the reply to onText (one piece at a time) and resolves with the full text.
async function ask(opts, onText = () => {}, signal) {
  if (provider.sdk === 'anthropic') {
    let text = '';
    const emit = (t) => { text += t; onText(t); };
    const finish = await askClaude(opts, emit, signal);
    if (finish === 'content_filter') emit(`${text ? '\n\n' : ''}Claude declined to answer this.`);
    else if (finish === 'length') emit('\n\n(Cut short: the reply hit its length limit.)');
    return text;
  }
  const stream = await getClient().chat.completions.create({ ...request(opts), stream: true }, { signal });
  let text = '', finish = null;
  const emit = (t) => { text += t; onText(t); };
  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (choice?.delta?.content) emit(choice.delta.content);
    if (choice?.finish_reason) finish = choice.finish_reason;
  }
  if (finish === 'content_filter') emit(`${text ? '\n\n' : ''}The AI declined to answer this.`);
  else if (finish === 'length') emit('\n\n(Cut short: the reply hit its length limit.)');
  return text;
}

// Meeting audio → text. One short WAV clip (a stretch of speech between pauses) at a time.
const NO_SPEECH = /^[\s\W]*$|^[[(]?(no speech|silence|inaudible|music|background noise)[\])]?\.?$/i;
async function transcribe(base64) {
  let text;
  try {
    if (hearing === PROVIDERS.gemini) {
      const r = await getClient(hearing).chat.completions.create({
        model: hearing.audioModel, max_completion_tokens: 1000,
        messages: [{ role: 'user', content: [
          { type: 'input_audio', input_audio: { data: base64, format: 'wav' } },
          { type: 'text', text: 'Transcribe the speech in this audio exactly. Output only the spoken words. If there is no speech, output nothing.' },
        ] }],
      });
      text = r.choices[0]?.message?.content ?? '';
    } else {
      const r = await getClient(hearing).audio.transcriptions.create({ model: hearing.audioModel, file: await OpenAI.toFile(Buffer.from(base64, 'base64'), 'speech.wav') });
      text = r.text ?? '';
    }
  } catch (e) {
    throw Object.assign(new Error(errorMessage(e, hearing)), { friendly: true }); // name the service that failed, not the answering one
  }
  text = text.trim();
  return NO_SPEECH.test(text) ? '' : text;
}

// Plain-language error for the user. Both SDKs use the same error class names.
function errorMessage(e, p = provider) {
  if (e.friendly) return e.message;
  const { name, keyVar } = p;
  const is = (cls) => e instanceof OpenAI[cls] || (Anthropic[cls] && e instanceof Anthropic[cls]);
  if (is('AuthenticationError')) return `${name} rejected the API key. Check ${keyVar} in the .env file, then restart the app.`;
  if (is('PermissionDeniedError') || is('NotFoundError')) return `Your ${name} key can't use this AI model. Pick another model in the session's settings.`;
  if (is('RateLimitError')) {
    if (p === PROVIDERS.gemini) return 'Gemini’s free limit was reached. Wait a minute and try again (the free plan also has a daily limit).';
    if (p === PROVIDERS.claude) return 'Claude is rate-limiting requests. Wait a few seconds and try again.';
    return e.type === 'insufficient_quota' || /quota|credit/i.test(e.code ?? '') // e.g. credit_balance_exhausted
      ? 'Your OpenAI account has no API credit left. Add credit at platform.openai.com under Billing.'
      : 'OpenAI is rate-limiting requests. Wait a few seconds and try again.';
  }
  if (is('BadRequestError')) return `${name} couldn't process this request: ${e.message}`;
  if (is('APIConnectionTimeoutError')) return `${name} took too long to answer. Try again, or pick a lighter model in the session's settings.`;
  if (is('APIConnectionError')) return `Couldn't reach ${name}. Check your internet connection and try again.`;
  if (is('APIError') && (e.status === 503 || e.status === 529)) return `${name} is overloaded right now. Try again in a moment, or pick a lighter model in the session's settings.`;
  if (is('APIError')) return `${name} returned an error (${e.status ?? 'unknown'}). Try again.`;
  if (e instanceof OpenAI.OpenAIError || e instanceof Anthropic.AnthropicError) return `${name} isn't set up yet. Put your key in ${keyVar} in the .env file, then restart the app.`;
  return e.message || `Something went wrong talking to ${name}.`;
}

/* ---- prompts ---- */
const CODE_RULE = 'If code is asked for, give one short sentence, then the complete code in a Markdown code block with its language, then 2-3 short bullets explaining the key lines.';
const KIND = { interview: 'job interview', regular: 'call', mock: 'mock interview' };
const themLabel = (s) => (s.mode === 'regular' ? 'Them' : 'Interviewer');
const transcriptText = (s, lines = s.transcript) =>
  lines.map((l) => `${l.speaker === 'me' ? 'Me' : themLabel(s)}: ${l.text}`).join('\n') || '(nothing has been said yet)';

function background(s, resume) {
  return [
    `This is a ${KIND[s.mode]} for the role "${s.title}" at ${s.company}.`,
    resume ? `<resume name="${resume.name}">\n${resume.text}\n</resume>` : 'No resume was provided.',
    s.context ? `<context>\n${s.context}\n</context>` : '',
  ].filter(Boolean).join('\n\n');
}

const answerPrompt = (s, resume, question) => ({
  model: s.model, maxTokens: 4000,
  system: `You help the user in real time during a live conversation. Write what the user could say next in reply to the latest question: first person, natural spoken language they can read aloud. Keep it to 2-5 short sentences, or up to 5 short bullets for technical answers. ${CODE_RULE} Ground it in the resume and context. Never invent employers, dates or numbers that are not there; speak generally instead. No preamble and no headings.`,
  messages: [{ role: 'user', content: `${background(s, resume)}\n\n<transcript>\n${transcriptText(s, s.transcript.slice(-40))}\n</transcript>\n\nQuestion to answer: ${question}` }],
});

// Chat: the user asks the AI directly during the call.
const directPrompt = (s, resume, message) => ({
  model: s.model, maxTokens: 6000,
  system: `You are the user's private assistant during a live call. Answer their message directly and concisely in Markdown. ${CODE_RULE}`,
  messages: [{ role: 'user', content: `${background(s, resume)}\n\n<recent-transcript>\n${transcriptText(s, s.transcript.slice(-20))}\n</recent-transcript>\n\n${message}` }],
});

// Screenshot: answer whatever question or task is on the user's screen.
const screenshotPrompt = (s, resume, image) => ({
  model: s.model, maxTokens: 8000,
  system: `You are the user's private assistant during a live call. The image is a screenshot of the user's screen. Work out the question or task it shows (for example a coding problem, a slide, a document or a form) and answer it concisely in Markdown. ${CODE_RULE} If nothing on the screen needs answering, say briefly what is shown.`,
  messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: image } },
    { type: 'text', text: `${background(s, resume)}\n\n<recent-transcript>\n${transcriptText(s, s.transcript.slice(-10))}\n</recent-transcript>\n\nWhat should I answer for what's on my screen?` },
  ] }],
});

const notesPrompt = (s, resume) => ({
  model: s.model, maxTokens: 12000,
  system: s.mode === 'mock'
    ? 'You are an interview coach. Review this mock interview transcript and write feedback in Markdown with these sections: "## Overall" (2-3 sentences and a score out of 10), "## Strengths" (bullets), "## Improve" (bullets that name the specific answer, plus a better example answer for the weakest reply). Base everything on the transcript.'
    : 'Write concise notes from a call transcript in Markdown with these sections: "## Summary" (2-4 sentences), "## Questions and answers" (bullets: each question asked and the gist of the reply), "## Follow-ups" (bullets: action items or things to prepare). Use only what the transcript says.',
  messages: [{ role: 'user', content: `${background(s, resume)}\n\n<transcript>\n${transcriptText(s)}\n</transcript>` }],
});

const chatPrompt = (s, resume, message) => ({
  model: s.model, maxTokens: 12000,
  system: `You answer the user's questions about one of their calls. Use the transcript, notes, resume and context below. If the answer isn't in them, say so. Reply in short Markdown.\n\n${background(s, resume)}\n\n<transcript>\n${transcriptText(s)}\n</transcript>\n\n<notes>\n${s.notes || '(no notes yet)'}\n</notes>`,
  messages: [...s.chat.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: message }],
});

// The interviewer speaks as the assistant; the candidate's answers are the user turns.
function mockPrompt(s, resume) {
  const messages = [{ role: 'user', content: '(The candidate has joined. Greet them briefly and ask the first question.)' }];
  for (const l of s.transcript) messages.push({ role: l.speaker === 'them' ? 'assistant' : 'user', content: l.text });
  if (messages.at(-1).role === 'assistant') messages.push({ role: 'user', content: '(The candidate did not answer. Move on to the next question.)' });
  return {
    model: s.model, maxTokens: 3000,
    system: `You are the interviewer in a mock interview for the role "${s.title}" at ${s.company}. Speak the way a real interviewer would. Ask one question at a time. After each candidate reply, give one short sentence of reaction, then ask the next question. Mix behavioural and role-specific questions and adapt them to the resume and context. Keep every turn under 70 words, in plain text with no Markdown, because it is read aloud.\n\n${background(s, resume)}`,
    messages,
  };
}

const pdfPrompt = (base64) => ({
  model: provider.pdfModel, maxTokens: 16000,
  messages: [{ role: 'user', content: [
    provider === PROVIDERS.gemini // Gemini's OpenAI-style endpoint rejects "file" parts but reads a PDF data URL
      ? { type: 'image_url', image_url: { url: `data:application/pdf;base64,${base64}` } }
      : { type: 'file', file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${base64}` } },
    { type: 'text', text: 'Return the full text of this document as plain text, keeping its headings and bullet points. Output only the document text.' },
  ] }],
});

module.exports = { provider, ask, transcribe, errorMessage, hasCredentials, answerPrompt, directPrompt, screenshotPrompt, notesPrompt, chatPrompt, mockPrompt, pdfPrompt };
