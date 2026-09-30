# Publishing ilAhi

This takes about 25 minutes and costs nothing. You'll need a GitHub account, a Google account and a Cloudflare account (free).

| Step | What you get | Time |
|---|---|---|
| 1. GitHub Pages | The site is live and builds starter plans | 5 min |
| 2. Gemini API key | A key the planner uses to write plans | 3 min |
| 3. Cloudflare Worker | Full AI plans on the public site | 15 min |
| 4. Connect the site to the Worker | Done | 2 min |

## 1. Publish the site on GitHub Pages

1. Push this repository to GitHub (for example `BhawanKey007/ilahi`).
2. In the repo, open **Settings → Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Open the **Actions** tab. The **Publish site** workflow runs on every push to `main`. If it hasn't run yet, open it and click **Run workflow**.
4. When it finishes, the site is at `https://<your-username>.github.io/ilahi/`.

At this point the site works, but it builds starter plans from its own data only.

## 2. Get a free Gemini API key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey) and sign in.
2. Click **Create API key** and copy it. Keep it private: don't paste it into chats, issues or any file in this repository.
3. In AI Studio, check which Flash models your key can use and their free limits. If `gemini-3.5-flash` isn't listed, note a Flash model that is. You'll need it in step 3.

The free tier needs no card. Google may use free-tier requests to improve its products, which is why the site's About page says so.

## 3. Deploy the planner Worker to Cloudflare

### 3a. Create the account and an API token

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up) (free plan).
2. Note your **Account ID**: it's shown in the right sidebar of **Workers & Pages**.
3. Go to **My Profile → API Tokens → Create Token**, pick the **Edit Cloudflare Workers** template, and create it. Copy the token.

### 3b. Let GitHub deploy the Worker

1. In your GitHub repo, open **Settings → Secrets and variables → Actions → New repository secret** and add:
   - `CLOUDFLARE_API_TOKEN`: the token from 3a
   - `CLOUDFLARE_ACCOUNT_ID`: your Account ID
2. If your GitHub username isn't `BhawanKey007`, edit `worker/wrangler.toml` and set `ALLOWED_ORIGINS` to `https://<your-username>.github.io`.
3. If AI Studio showed a different Flash model, set `GEMINI_MODEL` in `worker/wrangler.toml`.
4. Open **Actions → Deploy planner Worker → Run workflow**. When it finishes, the log shows the Worker's address, like `https://ilahi-planner.<your-subdomain>.workers.dev`.

### 3c. Add the Gemini key to the Worker

1. In the Cloudflare dashboard, open **Workers & Pages → ilahi-planner → Settings → Variables and Secrets**.
2. Click **Add**, choose type **Secret**, name it `GEMINI_API_KEY`, paste your key and save.

The key lives only in Cloudflare. It never goes into GitHub or the browser.

### 3d. Check it

Open `https://ilahi-planner.<your-subdomain>.workers.dev/health` in a browser. You should see `{"ok":true,"model":"gemini-3.5-flash"}`.

> If the deploy fails on the `[[ratelimits]]` block, delete that block from `worker/wrangler.toml` and run the workflow again. The Worker still works; it just won't limit requests per visitor.

## 4. Connect the site to the Worker

1. Edit `site/config.js` and set `plannerUrl` to your Worker address:
   ```js
   plannerUrl: "https://ilahi-planner.<your-subdomain>.workers.dev",
   ```
2. Commit to `main`. The site republishes in about a minute.
3. Plan a trip on the live site. The loading screen should say "ilAhi's AI planner writes the plan", and the result shouldn't have the **Starter plan** label.

## Keeping it running

- **Is everything working?** Open the site's **About** page: the last line shows the version and "AI planner: connected". For the Worker itself, `<worker>/health` should show `"keySet":true`, and `<worker>/selftest/quick` runs a tiny Gemini request and reports the result (it uses one request from your free quota).
- **Plans come back as "Starter plan":** the message at the top of the plan ends in a `ref` code. `no-planner` means `site/config.js` has no Worker address; `network` means the browser couldn't reach the Worker; `upstream_error-…` means Gemini refused (check the key and model with `/selftest/quick`); `invalid_json` means Gemini's answer was cut off or malformed.
- **Updating travel data:** edit `site/data/*.json` and push. The checks run automatically, then both the site and the Worker redeploy, because the Worker carries its own copy of the data.
- **Free limits:** all visitors share your Gemini free quota. When it runs out, visitors get starter plans until it resets. Check usage in Google AI Studio.
- **Abuse:** the Worker only answers requests from the sites in `ALLOWED_ORIGINS`, only accepts structured trip requests, and limits each visitor to 10 plans a minute.

## The Claude version

`npm run build:claude` builds `dist/claude/index.html` and its data folder: a single-page ilAhi that runs as a Claude artifact, where plans are written by each viewer's own Claude account.
