# aiHelper

A private AI assistant for calls and interviews. It listens to your meeting, suggests what to say in a small
overlay that screen sharing can't see, answers questions about what's on your screen, writes notes after the
call, and runs mock interviews to practise with.

Everything runs on your own computer with your own AI key. Your key never leaves your machine except to talk
to the AI provider you chose.

## Features

- **Live answers.** The overlay hears the other people in the meeting (your computer's sound), writes down
  what they say, and suggests an answer when someone asks a question. Press **Answer** (`Ctrl+Enter`) any time.
- **Screenshot.** `Ctrl+Shift+Enter` reads the screen under your mouse (a coding problem, a slide, a form)
  and answers it, with formatted code when code is needed.
- **Chat.** `Ctrl+Shift+Space` lets you type a question to the AI during the call.
- **Overlay hidden from screen sharing.** Clicks pass through everywhere except on its panels.
  `Ctrl+Shift+H` shows or hides it.
- **Sessions.** Interviews, regular calls and mock interviews with search, sorting and AI notes, a
  transcript, and Ask AI (questions about a past call).
- **Resumes and documents.** Upload a PDF or text resume or job description; answers use it.
- **Mock interviews.** An AI interviewer asks questions out loud and gives you feedback with a score.

## Requirements

- Windows 10 (version 2004 or later) or Windows 11
- [Node.js](https://nodejs.org) 22 or later
- Google Chrome (for your own microphone in the session page)
- An API key from one of: Google Gemini (free), OpenAI, or Anthropic (Claude)

## Setup

```bash
git clone https://github.com/aryann2611/aiHelper.git
cd aiHelper
npm install
copy .env.example .env      # on macOS/Linux: cp .env.example .env
```

Open `.env` in a text editor and paste your key after the matching `=`. Set `AI_PROVIDER` to `gemini`,
`openai` or `claude`. With `claude`, also add a Gemini key: it is used to hear the meeting, because Claude
can't listen to audio.

## Use it

```bash
npm run overlay
```

1. The overlay opens at the top of your screen and the app starts at <http://localhost:3000>.
2. Open <http://localhost:3000> in Chrome, create a session (role, company, resume, AI model), and press
   **Start call**. Allow the microphone when Chrome asks.
3. Join your meeting. The overlay's 🎧 **Listening** button shows it is hearing the meeting. Questions appear
   as chips and answers stream into the overlay.
4. Press **End call** (or **Exit** in the overlay). AI notes are written from the transcript.

Run `npm start` instead to use only the web app, without the overlay.

## Privacy

- API keys stay in `.env` on your computer. `.env` is in `.gitignore` and is never served to the browser.
- While a call is live, the overlay sends your computer's sound to the AI provider to be written down, and
  screenshots you take are sent to the AI. Stop listening with the 🎧 button when you don't need it.
- Sessions, transcripts and documents are saved in `data.json` in the project folder. Delete it to start over.

## Notes

- On the free Gemini plan, an answer takes about 5–20 seconds and busy meetings can hit the free rate limit.
- While the overlay runs, `Ctrl+Enter`, `Ctrl+Shift+Enter` and `Ctrl+Shift+Space` go to the overlay from any app.
- `npm test` runs the self-checks.
