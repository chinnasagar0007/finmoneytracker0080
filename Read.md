Step 1: Add environment variables on Vercel

Go to your Vercel project dashboard > Settings > Environment Variables. Add these 4:

Name	Value
TELEGRAM_TOKEN	xxxxxxxxx
GROQ_API_KEY	xxxxxxxx
TELEGRAM_CHAT_ID	xxxxxx
DASHBOARD_URL	https://script.google.com/macros/s/AKfycbxYTnaz7Umz0h_2fWCyMvJ509AKkireiwCf1n793gF2K-o22p10OwFy1BUfW-5wJ2ACRw/exec
Step 2: Push to git and deploy

Push the new files (vercel.json + api/telegram.js) to your repository. Vercel will auto-deploy.

Step 3: Register the webhook

Open this URL in your browser (replace YOUR_VERCEL_DOMAIN with your actual Vercel domain):

https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook?url=https://YOUR_VERCEL_DOMAIN/api/telegram


You should see {"ok":true,"result":true,"description":"Webhook was set"}.

Now type /start in bot

Step 4: Stop Apps Script polling

In your Apps Script editor, select function stopPolling and click Run. This removes the old polling triggers.

Step 5: Test

Send /summary on Telegram. You should get a response in 2-3 seconds with 100% consistent numbers every time.


commands:


To delete webhook 

https://api.telegram.org/bot8635300628:AAFgOHl-0F11rl2Cr3v0z8UGWMOimgXmdnI/deleteWebhook?drop_pending_updates=true

To clear cache in appsscripts

https://script.googleusercontent.com/macros/echo?user_content_key=AWDtjMVsE6Y0fG8X4upmRbctB6K8rhtx5G8NUOzCDbT1qNKQa8UPrMlBNWkXEMHeU2y37J6Z4sJ11BQicr_vIA3r_exma3wOHX32NomemSdFSBrFAT7OKCbYMyEV8Br-GYB84evMCLPfpN4HYCrZ-MDQU-gqzsT0wx4Y_RTfWHYTVkfT4w5vCrW5DiRhT3mQ3iGr6pxSUlBjYidRSi5R9ONv_86EX7lxqts-Yr1KLsU_K_L3-5sU0HHySBcGuLy1eyOaoa2JQQXuN_ef4aW-ANXkDrswkCQuU-vPHhgaXsw_k5doCbRWrr0&lib=MPg9o1bCE8Go4UQAp3Aw9dfut1y-0J1iD
