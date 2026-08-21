# Torn Happy Jump Insurance

Two-userscript project for managing Happy Jump insurance inside Torn.

## Files

- `torn-hji-manager.user.js` — provider/manager script.
- `torn-hji-client.user.js` — insured-player client.

## Manager v0.1.0

- Configurable insurance tiers.
- Tier name, type, duration, coverage text, DVD limit, cash price and alternative item payment.
- Customer database using Torn user ID as the stable identifier.
- Single-jump and time-based policies.
- Local payment records.
- Claims inbox.
- Structured Torn Mail claim import through Torn API v2 messages/newmessages.
- Claim statuses: submitted, reviewing, approved, rejected, paid, closed.
- Local JSON backup/export and import.
- Responsive floating UI intended for Tampermonkey and Torn PDA.

## Client v0.1.0

- Stores the insured player's provider and policy details locally.
- Shows current tier, coverage and validity.
- Creates unique claim references.
- Builds a structured claim message.
- Opens Torn Mail addressed to the configured provider.
- Tries to pre-fill the Torn mail subject/body; if Torn's current UI prevents this, the complete claim is copied to the clipboard as a fallback.
- Does **not** silently send messages. The insured player presses Torn's Send button.

## Torn Mail claim format

The manager recognizes claims containing:

```
[HJI CLAIM]
Claim Reference: HJI-...
Claimant Name: ...
Claimant ID: ...
Provider Name: ...
Provider ID: ...
Tier: ...
Submitted: ...

Claim Details:
...

Evidence / Link:
...
```

## GitHub setup

Repository: `DooBiiE/Torn-Happy-Jump-Insurance`

Suggested repository layout:

```
/
├── torn-hji-manager.user.js
├── torn-hji-client.user.js
└── README.md
```

Both userscripts are configured to install and update from the raw files on the `main` branch.

## Important v0.1 limitation

The provider database and the insured player's policy display are local to each installation. Torn Mail is used to move claims from the insured player to the provider, but policy changes are not automatically pushed from provider to client yet.

A good next step is a provider-generated setup/policy code that the insured script can import, without requiring a hosted backend.
