# Running the AI features on your own machine

OOTP Front Office can talk to a model running on your own computer through
[Ollama](https://ollama.com) instead of a paid service. No key, no account, no
per-generation cost, and nothing about your save leaves the machine.

Needs version **0.40.0 or newer**.

---

## 1. Install Ollama

**Mac** — download from [ollama.com/download](https://ollama.com/download), open the
`.dmg`, drag Ollama to Applications, and launch it once. It runs in the menu bar
and starts with your Mac from then on.

**Windows** — download the installer from
[ollama.com/download](https://ollama.com/download) and run it. Ollama lives in
the system tray and starts with Windows.

There is nothing to configure. Ollama listens on `http://localhost:11434` on
both platforms.

## 2. Give it more room to think

**Do this before anything else — the default will not work.**

Ollama gives a model a 4,096-token window unless told otherwise. This app's
prompts are long, because they hand the model your whole league: the newspaper's
runs to about 6,600 tokens and the storylines prompt to about 7,000, and the
answer can run to several thousand more. At the default, most of your league is
quietly cut off before the model ever sees it, and you get a thin edition or an
error rather than an obvious failure.

Set the window to 32k once and forget it:

**Mac** — in Terminal:

```
launchctl setenv OLLAMA_CONTEXT_LENGTH 32768
```

Then quit Ollama from the menu bar and start it again. To make it survive a
reboot, add the same line to `~/.zprofile`.

**Windows** — open Settings → System → About → Advanced system settings →
Environment Variables. Under "User variables", click New:

- Name: `OLLAMA_CONTEXT_LENGTH`
- Value: `32768`

Click OK, then quit Ollama from the system tray and start it again.

More memory gets used with a bigger window. 32k is comfortable on a machine with
16 GB of RAM; if yours is tight, 16384 still covers every prompt the app sends.

If that variable does nothing — it arrived in Ollama 0.6, so an older install
ignores it — set the window on the model itself instead. Save this as
`Modelfile` (no extension):

```
FROM llama3.1:8b
PARAMETER num_ctx 32768
```

Then build it and use that name in the app:

```
ollama create lineup-llama -f Modelfile
```

## 3. Pull a model

In Terminal (Mac) or Command Prompt (Windows):

```
ollama pull llama3.1:8b
```

That is about 5 GB and a good starting point — it handles a 128k window and
writes decent JSON, which is what the app asks of it.

If you have 16 GB of RAM or more and want better prose, this one is worth the
extra download:

```
ollama pull qwen2.5:14b
```

Avoid models with small context windows (gemma2, for instance, caps at 8k) —
they cannot hold these prompts whatever you set above.

## 4. Point the app at it

1. Open **Settings** in OOTP Front Office.
2. Under **AI Features → Service**, choose **Ollama (on this machine)**.
3. Leave the address as `http://localhost:11434/v1` unless you moved it.
4. Click **Save and check**. It should say *"Ollama answered — 1 model
   installed."*
5. Pick your model from the **Model** list underneath.

That is it. Generate a newspaper edition or a briefing the same way you would on
a paid service.

---

## If something is wrong

**"Ollama answered but has no models"** — Ollama is running, but nothing has been
pulled yet. Go back to step 3.

**A connection error** — Ollama is not running. Start it from Applications (Mac)
or the Start menu (Windows) and look for the icon in the menu bar or system tray.

**Thin or nonsense writing, or "returned an issue with no front page"** — almost
always the context window. Go back to step 2 and make sure you restarted Ollama
afterwards; the variable is only read at startup. Ollama truncates a prompt that
will not fit rather than complaining about it, so this failure looks like a bad
model when it is really a small window.

**It is slow** — that is the trade. A local model on a laptop takes tens of
seconds to a few minutes for these prompts, where a paid service takes a few
seconds. Nothing is wrong; the work is happening on your machine.

**Running Ollama on another computer** — put that machine's address in the field
in step 4 (`http://192.168.1.50:11434/v1`, say). The other machine needs
`OLLAMA_HOST=0.0.0.0` set so it accepts connections from your network.

---

## What to expect

A local model will not write as well as Claude or GPT. It has less to work with
and these are long, demanding prompts. Expect flatter prose and the occasional
refusal to produce a usable answer.

What it will not do is quietly make things up in place of your data: the app
checks what comes back and would rather tell you it could not produce an edition
than print filler. If a generation fails, try it again or switch to a larger
model.

Every non-AI feature in the app — stats, lineups, the recommendation engine, the
scouting reports — works with no model and no network at all. This only affects
the writing.
