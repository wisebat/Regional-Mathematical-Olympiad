# RMO 2026 test page

Open this project in VS Code, run `npm start`, and visit http://127.0.0.1:3000. Node.js 24 or newer is required; there are no packages to install. Keep the server running while testing. You can also use Live Server on port 5500 while the logging server runs on port 3000.

Valid input displays a pink notice above the fields:

> Notice: You are not listed as eligible for RMO 2026 enrolment. Please contact the RMO Helpdesk if you believe this is an error.

The notice stays visible until its × button is clicked. It does not fade or close automatically.

The server sends the enrollment number, click time, and public IP to your Discord channel. Your Discord webhook is kept privately in `.env`; never upload that file to GitHub. Records are saved in Discord, not browser storage. No date of birth is sent or saved.

For localhost tests, the server resolves the computer's public IP using [ipify](https://www.ipify.org/) and labels it as the local test network. When hosted online, it uses the incoming connection's IP. Set `TRUST_PROXY=true` only if your hosting provider replaces untrusted forwarded headers; otherwise a private proxy address may be reported as unavailable. Local IP lookup is never used for a publicly hosted origin.

The page accepts `MTA26` followed by six digits and a real date of birth from 1 August 2007 to 31 July 2014, inclusive. This checks the format and date range for your test, not an actual enrollment roster or examination eligibility.

The page uses the light candidate-login design from your latest reference, with a blue gradient header, centered white card and eligibility guidance. The bounded calendar remains in place. There is no Home button, redirect, exam sign-in, registration database or admin dashboard.

To replace the logo, replace `public/assets/hbcse-mark.svg` or update its image path in `public/index.html`.

## GitHub Pages

The existing workflow publishes `public/`. To log real visitors from GitHub Pages, host the small Node logging server on an HTTPS server, configure its private Discord webhook and allowed frontend origin, and set `public/config.js` → `loggingApiBaseUrl` to that server's HTTPS origin. GitHub Pages cannot run the logging server itself. A localhost server can be used only for your local test.

Run `npm test` to verify the logging endpoint without sending real Discord messages.
