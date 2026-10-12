# An image worth preserving for the next hundred years

A local exhibition in two phases. AI 1 directs and evaluates; AI 2 generates and revises images. The audience watches ten sets unfold, then explores the saved images and the decisions behind them.

**To run this online with Render, follow [RENDER-SETUP.md](RENDER-SETUP.md).** The prepared `render.yaml` creates a hosted exhibition with a persistent disk and password-protected operator controls. The Mac instructions below are for local use.

## Start on your Mac

1. Double-click **Start Exhibition.command**. A Terminal window starts the exhibition and opens it in your browser. Keep that window open.
2. Open **Setup** in the exhibition. Enter your [OpenAI API key](https://platform.openai.com/api-keys), then save. Your API account needs available [billing or credits](https://platform.openai.com/settings/organization/billing/overview) and access to the selected models.
3. Press **Start** when you are ready. Opening the page or saving settings does not start generations.

After saving settings, **Check connection** can confirm that OpenAI's model list is reachable and whether the selected model names appear. It does not generate anything or confirm billing or image-generation permissions. While paused, **Save files** downloads a backup containing the images, records and state; this works before all ten sets finish.

The launcher uses Node.js already available on your Mac, including Codex's bundled runtime. No package installation is required. If it cannot find a suitable runtime, install the current LTS version of [Node.js](https://nodejs.org/) and open the launcher again. Node.js 20 or newer is required.

If the browser does not open, visit **http://127.0.0.1:8787**. This address is available only on the computer running the exhibition. If macOS requires confirmation before opening the launcher, use Finder's **Open** action for the file.

## The experiment

Every set begins with the same instruction:

> An image worth preserving for the next hundred years.

AI 1 chooses an interpretation and writes an image prompt. AI 2 produces an image. AI 1 then examines the actual image and either accepts it or requests a revision. The latest image is supplied for editing when a revision is requested.

For new collections, AI 1’s initial and revision prompts each have a maximum of **20 whitespace-separated words**. Its private explanations are separate. If AI 1 exceeds the prompt limit, the experiment pauses before sending those instructions to AI 2; press Start to retry that step. Saved collections retain their original system prompts, so use a fresh data directory to begin an experiment with the new limit. Acceptance remains AI 1’s decision; revisions are not forced.

- There are **10 sets**. In new collections, each proposal receives its set number and compact summaries of earlier sets (initial prompts, preservation reasons, and the latest used revision prompt where applicable). AI 1 is instructed to choose a conceptually and visually distinct interpretation for each set, rather than repeat a subject with cosmetic changes. It chooses the ten approaches itself; distinctness remains a model judgment, not a guaranteed semantic check. Reviews still use only the current set. Older collections retain their saved context policy.
- Each set allows **1 initial image plus up to 9 revisions**.
- An **ACCEPT** decision ends the current set immediately.
- AI 1 also evaluates the tenth image. If it requests another revision, the set ends as **Unresolved**; its requested changes are saved but not executed.
- A completed collection contains **10–100 images**, plus AI 1's text and visual evaluations. Image requests and text/vision requests both incur API charges.

### Phase 1: live process

The audience sees AI 1’s initial and revision prompts on the left and AI 2’s image on the right, with the working panel outlined in green and slightly enlarged. Directional links show the exchange, and the ten-set gallery stays visible below on TV-sized screens. Progress and acceptance or revision statuses remain visible. AI 1's preservation reasons, evaluation reasons and changes of intention are recorded but hidden from the public display.

Use **Start / Pause** to control the experiment. Pause lets the current API request finish and saves its result before stopping; it does not cancel an image already being generated. A later Start continues from saved progress.

### Phase 2: saved exhibition

After all ten sets finish, generation stops automatically. The gallery shows the completed collection, including the reasons recorded during creation. Playback can present the saved results without generating more images. On TV-sized screens, the replay view places initial/revision prompts above side-by-side preservation and decision reasons; a change of intention appears below. It shows the full saved text without truncation or a nested scroll box, fitting type to the available space when a record is longer. The image and ten-set gallery remain visible. At narrow mobile sizes the page flows vertically.

The completed exhibition uses local files and can run without an internet connection. Keep the local server running while displaying it.

## Before exhibiting

- Keep the Mac awake and connected to power. Internet is required during Phase 1.
- Leave the launcher's Terminal window open. Close it, or press Control-C inside it, to stop the server.
- Generation speed depends on the chosen models, image settings, network and API availability. Allow the gallery to remain visible between new images.
- Check your API account's usage controls and available credit. The image-count limit is not a fixed monetary budget.
- Start with the defaults, but confirm that your API account can use both models before the public run. A configuration error pauses the experiment and displays the returned problem.

The application does not automatically retry failed API requests. Check the error and press Start to resume when ready. If a connection fails after the provider has processed a request, repeating that step may incur another charge; a missing response cannot prove that no charge occurred.

If OpenAI reports **Country, region, or territory not supported**, check its [API supported-country list](https://developers.openai.com/api/docs/supported-countries). This is a regional access restriction; changing the model, creating another key, or adding credits does not resolve it. If you are in a listed location, contact OpenAI support about the regional error. The original error code and message are saved in `data/records/`.

## Saved work and privacy

All experiment files stay in this project folder:

| Location | Contents |
| --- | --- |
| `data/state.json` | Progress, decisions, prompts and references to saved images |
| `data/images/` | Generated image files |
| `data/records/` | Recorded API responses and metadata, including hidden explanations |
| `.env` | Your local API key and settings |

The API key is kept on the local server and is not returned to the browser after saving. Settings saved by the application use owner-only file permissions. Both `.env` and `data/` are excluded from version control. Still, do not share `.env` or screenshots containing a typed API key. Prompts and images needed for generation and evaluation are sent to the API provider.

Refreshing the browser preserves progress. Restarting the server restores saved progress **paused**; press Start to continue an unfinished collection. A finished collection opens in Phase 2 and makes no new generation requests.

To back up the exhibition, pause it, wait for the current request to finish, stop the server, and copy the entire `data` folder. Keep the project files with the backup so it can be displayed again.

To begin a completely new collection, stop the server and move the existing `data` folder somewhere safe before relaunching. There is no destructive reset button.

## Optional configuration

Use the Setup control, or copy `.env.example` to `.env` and fill it in. Restart the server after editing `.env` manually.

| Setting | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Empty | Your API key; required for live generation |
| `AI1_MODEL` | `gpt-4.1` | Director and image evaluator; must support image input and structured responses |
| `AI2_MODEL` | `gpt-image-2.5-flare` | Image generator; must support generation and image editing |
| `IMAGE_QUALITY` | `medium` | Image-generation quality |
| `PORT` | `8787` | Local server port |

Availability and pricing can change. See OpenAI's [image-generation documentation](https://developers.openai.com/api/docs/guides/image-generation) and [vision documentation](https://developers.openai.com/api/docs/guides/images-vision) when choosing alternative models. Pause before changing settings. Model and quality changes during a collection are recorded in its archive because they change the experiment's conditions.

## Run from Terminal

From this folder, run:

```sh
node server.mjs --open
```

Or run `node server.mjs` and open the local address yourself. The server binds to `127.0.0.1` rather than your public network address.

Run the automated checks with:

```sh
node --test test/*.test.mjs
```

These checks do not establish the visual quality of a paid model run. Use the first live set to assess image output, timing and whether AI 1's decisions match the experiment you intend.
