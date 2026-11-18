# aiHelper

A private AI assistant for calls and interviews. It listens to your meeting, suggests what to say in a small
overlay that screen sharing can't see, answers questions about what's on your screen, writes notes after the
call, and runs mock interviews to practise with.

Everything runs on your own computer with your own AI keys. Keys never leave your machine except to talk to
the AI services you chose.

## Download

**[Download aiHelper for Windows](https://github.com/aryann2611/aiHelper/releases/latest/download/aiHelper-Setup.exe)**
· website: <https://aryann2611.github.io/aiHelper>

1. Run `aiHelper-Setup.exe`. If Windows says "Windows protected your PC", click **More info**, then **Run anyway**
   (the app isn't signed with a paid certificate).
2. aiHelper opens **⚙ Settings** on first start. Paste your keys:
   - [Groq](https://console.groq.com/keys) (free): hears the meeting
   - [Gemini](https://aistudio.google.com/apikey) (free): backup for hearing when Groq's free limit is reached
   - [Claude](https://console.anthropic.com/settings/keys): writes the answers
3. Press **Start a call** in the overlay, join your meeting, and answers appear as questions are asked.

Keys are saved only in `%APPDATA%\aiHelper` on that PC. The download contains no keys.

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

## Run from source

Needs Windows 10 (version 2004 or later) or 11 and [Node.js](https://nodejs.org) 22 or later.

```bash
git clone https://github.com/aryann2611/aiHelper.git
cd aiHelper
npm install
copy .env.example .env      # then paste your keys into .env
npm run overlay
```

`AI_PROVIDER` in `.env` picks who writes answers: `claude` (default), `gemini` or `openai`. Meeting audio is
written down by Groq, falling back to Gemini.

- `npm start` runs only the web app at <http://localhost:3000>, without the overlay.
- `npm run dist` builds the installer into `dist/`.
- `npm test` runs the self-checks.

## Privacy

- API keys stay in `.env` (or `%APPDATA%\aiHelper\.env` for the installed app). It is in `.gitignore`, is never
  served to the browser, and the app only accepts requests from your own computer.
- While a call is live, the overlay sends your computer's sound to the hearing service to be written down, and
  screenshots you take are sent to the AI. Stop listening with the 🎧 button when you don't need it.
- Sessions, transcripts and documents are saved in `data.json` next to `.env`. Delete it to start over.
