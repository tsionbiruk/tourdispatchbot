# Tour Dispatch Bot

## Overview

The Tour Dispatch Bot is a backend system designed to automate the assignment of tour guides using Monday.com and Slack. It enables managers to initiate a dispatch process from a Monday board, notify guides via Slack, and assign the first guide who accepts the offer.

The system integrates three main components:

* Monday.com for workflow triggering and status tracking
* Backend services for decision logic and processing
* Slack for real-time communication with guides

---

## System Workflow

1. A manager initiates a dispatch from the Tour board in Monday.com
2. The backend receives a webhook event
3. The system:
   * retrieves tour details
   * determines dispatch mode
   * selects eligible guides (based on tours/hosts + manual selection if applicable)
4. Slack messages are sent to the selected guides
5. The first guide to accept is assigned
6. Other guides attempting to accept will receive a "tour already assigned" response
7. The Monday board is updated with:
   * Assigned guide
   * Dispatch status
   * Dispatch results/logs

---

## System Architecture

Monday.com → Backend → Slack → Backend → Monday.com

---


## Project Structure

```
tour-dispatch-bot/
│
├── src/
│   ├── routes/
│   │   ├── mondayWebhook.ts
│   │   └── slackInteractions.ts
│   │
│   ├── services/
│   │   ├── mondayService.ts
│   │   ├── slackService.ts
│   │   ├── offerService.ts
│   │   ├── guideSelectionService.ts
│   │   └── schedulerService.ts
│   │
│   ├── types/
│   └── utils/
│
├── database/
├── logs/
├── package.json
├── tsconfig.json
└── .env
```

---

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```
MONDAY_API_TOKEN=
MONDAY_TOURS_BOARD_ID=
MONDAY_GUIDE_INFO_BOARD_ID=

MONDAY_DISPATCH_TRIGGER_COLUMN_ID=
MONDAY_TOUR_DISPATCH_MODE_COLUMN_ID=
MONDAY_TOUR_MANUAL_GUIDES_COLUMN_ID=
MONDAY_DISPATCH_STATUS_COLUMN_ID=
MONDAY_TOUR_ASSIGNED_GUIDE_COLUMN_ID=

SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_APP_TOKEN=

PORT=3000
```

Do not commit the `.env` file to version control.

---

## Installation

Install dependencies:

```
npm install
```

---

## Running the Application

### Development Mode

Start the development server:

```
npm run dev
```
Server runs on:

```
http://localhost:3000
```
---

### Production Mode

Build the project:

```
npm run build
```
Start the production server:
```
npm start
```


---

## Deployment

The application is currently tested locally using ngrok. For production use, it should be deployed on a persistent server.

### Deployment Requirements

- Node.js (v18 or higher recommended)
- A publicly accessible HTTPS endpoint
- Environment variables configured on the server
- Persistent storage for the `database/` folder

### Running in Production

It is recommended to run the service using a process manager such as:

- PM2
- Docker
- systemd

This ensures the service remains active and automatically restarts if it crashes.

### Important Notes

- The backend must be accessible via a public URL for webhook integrations
- Replace ngrok with the company’s server endpoint in production
- Ensure environment variables are securely stored on the server

---

## Webhook Setup (Monday.com)

1. Start the backend server
2. Expose the server using a tunneling service such as ngrok:

```
ngrok http 3000
```

3. Copy the public URL and append the webhook route:

```
https://your-ngrok-url/webhooks/monday
```

4. Register the webhook using the Monday API:

```graphql
mutation {
  create_webhook(
    board_id: YOUR_BOARD_ID,
    url: "YOUR_NGROK_URL/webhooks/monday",
    event: change_column_value
  ) {
    id
  }
}
```
---

## Slack Setup

To enable Slack interactions:

1. Go to your Slack app settings  
2. Navigate to **Interactivity & Shortcuts**  
3. Enable interactivity  
4. Set the Request URL to:

```
https://your-domain/slack/interactions
```

For local testing, use your ngrok URL:

```
https://your-ngrok-url/slack/interactions
```

5. Save changes  

This endpoint handles all button interactions such as Accept and Decline.

---
---

## Testing

To verify the integration:

* Modify any column value in the Tour board
* Confirm that the backend receives and logs the webhook event
* Ensure dispatch logic is triggered only for the designated column

---

## Dispatch Modes

* `all_guides`: Sends the offer to all eligible guides
* `manual_selection`: Sends the offer only to selected guides

---

---

## Notes

- The ngrok URL changes each time the service is restarted; update the webhook accordingly  
- Do not include `node_modules`, `.env`, or log files in the repository  
- Ensure all required environment variables are set before running the application  
- The application uses a local SQLite database stored in the `database/` folder  
- Ensure this folder exists and is persistent in production environments  
- In development, ngrok is used to expose the local server  
- In production, this should be replaced with the company’s server endpoint 

---

## Team Setup

To run the project locally:

```
git clone <repository_url>
npm install
```

Create a local `.env` file with the required credentials.

---

## Future Improvements

* Deployment to a persistent hosting environment
* Enhanced monitoring and logging
* Improved guide selection strategies
* Retry and timeout handling for dispatch operations

---

## Author

Tsion Ephrem
