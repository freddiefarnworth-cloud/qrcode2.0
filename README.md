# Member QR Perks

This project serves QR code-based membership perks through a serverless API and a small embeddable widget.

## Authentication

The `/api/my-codes` endpoint requires an authenticated request. Clients must include a Supabase access token in the `Authorization` header:

```
Authorization: Bearer <access_token>
```

Tokens are validated with `supabase.auth.getUser` and must belong to the same email address supplied in the request.

### Widget

The script served at `/public/widget.js` forwards a token with each API call. Provide the token via a `data-token` attribute when embedding the widget:

```html
<div id="member-qr-widget"></div>
<script src="/public/widget.js"
        data-api="/api"
        data-email="member@example.com"
        data-token="ACCESS_TOKEN"></script>
```

The widget uses the token for requests to `/api/my-codes` and displays the member's current perks.
