# Privacy

ilAhi has no accounts, no database, no cookies and no analytics.

## What stays on your device

- The trip details you type, until you ask for a plan.
- Saved trips, which are stored in your browser's local storage on that device. Clearing your browser data deletes them.
- Suggestions, checks and budgets, which are worked out in your browser.

## What's sent to an AI to write your plan

When you tap a destination, ilAhi sends these details to its AI planner: start city, dates, number of days and travellers, group type, budget level, interests, passport type (Indian or other), any notes you typed, and the chosen destination. For changes, it also sends the current plan and your change request.

- **On the public website**, this goes through ilAhi's Cloudflare Worker to Google's Gemini API. The Worker doesn't store it. On Gemini's free tier, [Google may use it to improve its products](https://ai.google.dev/gemini-api/terms). Don't put personal details such as names, phone numbers or health information in the notes.
- **Inside Claude**, it goes to the viewer's own Claude account, under that account's settings.
- **If no AI is connected**, nothing leaves your device.

## Sharing

"Share on WhatsApp" opens WhatsApp with the plan text for you to send. ilAhi doesn't send anything itself.
