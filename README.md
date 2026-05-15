# AutomateGS

AutomateGS connects Claude to your Google Workspace so you can create, run, and schedule Google Apps Script automations by describing what you want in plain English — no coding required. Everything runs inside your own Google account.

## How it works

**Describe your automation.** Tell Claude what you want to automate: "Every Monday, pull last week's sales from column B, calculate the totals, and email a summary to my manager." Claude writes the Google Apps Script code and deploys it to a new script project in your account.

**Preview it first.** For any automation that writes data or sends messages, Claude creates a staging copy of your spreadsheet, runs the automation against it, and hands you a link to review the results. You can inspect every change before anything touches your live data.

**Activate and schedule.** When you're satisfied with the preview, confirm it and Claude marks the automation as active. From there you can run it on demand or set a recurring schedule — hourly, daily, or weekly — with a single instruction.

## The safety model

AutomateGS never modifies your real data until you say so. Every write automation goes through the sequence: write → preview on a staging copy → you review → activate. The preview sheet is a throwaway copy that gets deleted after you decide. Your real data is never touched until you explicitly approve the result.

## Getting started

**Prerequisites:** Node.js 20 or later, a Google account with Google Apps Script API enabled.

**Installation:** Download the `.mcpb` file from the releases page and install it in Claude Desktop via Settings → Extensions → Install from file.

**First run:** On the first automation you create, a browser window will open for Google sign-in. You will see one consent screen asking for Apps Script access. This happens once per machine.

## Plans

| | Free | Pro | Agency |
|---|---|---|---|
| Automations | 1 | Unlimited | Unlimited |
| Runs | 10 total | Unlimited | Unlimited |
| Preview & activate | — | Yes | Yes |
| Scheduling | — | Yes | Yes |
| Version control | — | — | Yes |
| Templates | Basic | More | All |

Subscribe at https://thedatastudents.com/automategs

## Privacy

Your automations run in your own Google account. AutomateGS never stores, reads, or transmits your data. The only data that leaves your machine is the script code that gets deployed to Google's Apps Script infrastructure under your account.

## Support

hello@thedatastudents.com
