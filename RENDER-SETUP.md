# Put Hundred Years online with Render

You can set this up in your own accounts. You do not need your teammate's Render service, and no Terminal commands are required for the steps below.

GitHub will hold the application files. Render will run the application and keep the generated images. OpenAI will supply the two models. Your audience opens the Render website; only you sign in to start or pause the experiment.

## What you need

- A [GitHub account](https://github.com/signup) and a [Render account](https://dashboard.render.com/register).
- Your OpenAI API key, with API billing enabled and access to both models.
- A payment method for Render.
- A new operator password of **at least 16 characters**. Save it somewhere you can retrieve it; it is separate from your Render password and API key.
- The clean deployment ZIP supplied with this guide. Extract it into a new folder.

This deployment starts a fresh collection. It does not transfer any experiments already saved on your Mac.

## Cost to expect

For this configuration, the base hosting cost is **US$7.25 per month** if kept running for a full month: $7 for the smallest paid web service and $0.25 for its 1 GB disk. Choose the **Hobby workspace**, which has no monthly workspace fee. This is separate from OpenAI usage. Taxes and usage beyond included allowances can add charges. Hobby currently includes 5 GB of outbound bandwidth per month, then charges $0.15/GB. Prices checked **10 October 2026**; review Render's displayed charges before deploying. [Render pricing](https://render.com/pricing)

The application saves images on a persistent disk, so it needs a paid web service. Render's free web services cannot attach that disk. [Persistent disks](https://render.com/docs/disks)

## 1. Upload the prepared files to GitHub

1. Sign in to GitHub and open [New repository](https://github.com/new).
2. Name it **hundred-years** and choose **Private**. Leave the optional README, license and gitignore initialization off; these files are already supplied. Click **Create repository**. [GitHub's repository guide](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository)
3. On the empty repository page, choose **uploading an existing file**. For an existing repository, use **Add file → Upload files**.
4. Open the freshly extracted deployment folder. Upload its **contents**, including the `public`, `prompts` and `test` folders. Do not upload the ZIP itself or wrap everything inside another `preserve-100` folder.
5. Commit the uploaded files to the main branch. [GitHub's upload guide](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)

On the repository's first page, you should now see `package.json`, `render.yaml` and `server.mjs` directly in the file list. This means the files are at the correct level.

Use the clean ZIP, **not your working project folder containing `.env` or `data/`**. The upload must not include API keys, generated records or saved images. On a Mac, Command–Shift–Period shows hidden files if needed. The supplied `.env.example` contains placeholders and is safe to upload; `.env` is not.

## 2. Create the Render service

1. Sign in to [Render](https://dashboard.render.com/). Use a **Hobby workspace**.
2. Choose **New → Blueprint**. Connect your GitHub account if requested, and grant Render access to **only the hundred-years repository**. If the repository is missing, adjust Render's GitHub app permissions to include it. [Connecting GitHub](https://render.com/docs/git-provider)
3. Select that repository. Name the Blueprint **hundred-years**. Use your main branch and the default Blueprint path, **render.yaml**.
4. Render reads the prepared configuration. It should show **one web service**, in **Oregon**, with the **0.5c-512mb** compute plan and a **1 GB persistent disk**. This compute plan was previously called Starter. [Compute plan names](https://render.com/docs/compute-plans)
5. Fill in the two secret fields Render requests:

   | Field | Enter |
   | --- | --- |
   | `OPENAI_API_KEY` | Your OpenAI API key |
   | `ADMIN_PASSWORD` | Your new operator password, at least 16 characters |

6. Review the service, disk and displayed charges. Add your payment method if requested. Click **Deploy Blueprint** when you are ready to create the paid service. [Blueprint setup](https://render.com/docs/infrastructure-as-code)
7. Wait for the service to become **Live**, then open its `https://…onrender.com` address. Render supplies this address; you do not need to buy a domain.

The deployment does **not** start AI generations. It opens an empty exhibition waiting for you to press Start.

After deployment, open the **Blueprint's Settings** and set **Auto Sync → No**. Automatic service deployment is already off in the prepared configuration; disabling Blueprint auto-sync also prevents later configuration edits from unexpectedly restarting the exhibition. [Blueprint sync settings](https://render.com/docs/infrastructure-as-code#disabling-automatic-sync)

## 3. Check the connection, then run

1. Open the new exhibition website and use the **Operator** sign-in with your `ADMIN_PASSWORD`.
2. In the operator panel, press **Check connection**. This asks OpenAI for model availability from Render's connection; it does not generate images.
3. If the check succeeds and both configured models are listed, press **Start** when ready. Only the first real generation confirms that billing and image-generation permissions work.
4. Observe the first set. Use **Pause** if you want to stop; the current request finishes and saves before the experiment pauses. **Start** resumes the saved collection.

The prepared defaults retain your selected models: `gpt-6.1-sol` for AI 1, `gpt-image-2.5-flare` for AI 2, and `medium` image quality. A model can be valid but unavailable to your account. To change models or quality, pause first, wait for the current request to finish, then edit them in the application's **Operator** panel and save. These settings persist on the disk and take precedence over Render's initial model defaults. Keep the same models throughout a collection when comparing decisions.

To replace the API key or operator password, use the service's **Environment** settings in Render. These secrets are managed there, not through the public website. Applying an environment change restarts the app and restores the collection paused.

There are **10 sets**, each allowing one initial image and up to nine revisions. An accepted image ends its set early. A tenth rejected image ends the set as **Unresolved**. After ten sets, the app switches to the saved exhibition and stops generation automatically. The maximum is 100 generated images, not a fixed dollar limit.

Hosting changes the network from which requests reach OpenAI. It does not guarantee access or remove account, billing or regional restrictions. If Check connection still reports `unsupported_country_region_territory`, keep the experiment paused and contact OpenAI support with that error. Do not assume another key or more credit will resolve it.

## 4. Show it to an audience

Share the `onrender.com` address. Visitors can watch the live process and browse the saved gallery without an operator password. The password protects Start/Pause, settings, connection checks and full backups.

During Phase 1, preservation and evaluation reasons stay out of the public response. In Phase 2, the completed exhibition reveals those reasons alongside the images. Visitors cannot start a new paid run.

The experiment runs on Render even if you close your browser or turn off your Mac. **Closing the browser does not pause it.** Use the Pause control when you want it to stop. The audience still needs an internet connection to view the hosted website.

## 5. Save a backup and keep the collection

While signed in as the operator, press **Pause** and wait until the current request has finished. Then click **Save files** beside the experiment controls. It downloads a `.tar.gz` archive containing the images, records and experiment state. Save a copy on your Mac. This full backup includes the reasons hidden from the audience during Phase 1. You can also download it from your site's `/api/backup` address while signed in.

The persistent disk stores the collection in `/var/data/hundred-years` and preserves it across normal service restarts and redeployments. Keep the service at **one instance**; Render disks attach to only one instance. You can increase the disk size later if it fills. [Disk behavior](https://render.com/docs/disks)

Pause and download a backup before changing the service or deploying an updated version. A completed collection continues to display without making new model requests, but **Render hosting charges continue while it is hosted**. The app's Pause button pauses AI work, not the hosting bill. Back up before deleting a service or disk; deletion removes the hosted collection.

## If something does not work

| What you see | What to check |
| --- | --- |
| Render cannot find `render.yaml` or `server.mjs` | The extracted contents should be at the GitHub repository's root, not one folder below it. |
| The repository is missing in Render | Allow the Render GitHub app to access that specific private repository. |
| Deployment fails | Open the service's **Logs**. Check that both secrets are set and that `ADMIN_PASSWORD` is at least 16 characters. |
| Operator login fails | Use the value of `ADMIN_PASSWORD`, not your Render account password. |
| A model is unavailable | Check the exact model ID and your account's access; Check connection cannot prove generation permission. |
| An API error pauses the experiment | Read the error, resolve it, then press Start. Failed requests are not retried automatically. |
| The service restarted | Sign in again. Saved progress returns paused; press Start to continue. |

For reference, `render.yaml` selects Node 24, `node --check server.mjs` as the build command, `node server.mjs` as the start command, and `/healthz` as the health check. You do not need to enter these manually. Render's port and public URL are detected automatically.
