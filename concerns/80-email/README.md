# 80-email

Set up Ahasend for transactional emails: register `email.<root>` at Ahasend, write SPF/DKIM/DMARC/return-path records to Cloudflare, wait for validation, send a test email, and write `AHASEND_FROM_EMAIL` to `.env`.

Status: **v0.2** — implemented.
