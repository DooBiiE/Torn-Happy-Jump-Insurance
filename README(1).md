# Torn Happy Jump Insurance

A two-userscript project for managing Happy Jump insurance inside Torn.

Built for both **Tampermonkey/Desktop** and **Torn PDA**.

Author: **DooBiiE**

Repository: `DooBiiE/Torn-Happy-Jump-Insurance`

---

## Current builds

- **Manager:** v0.4.31
- **Client:** v0.4.5

## Files

- `torn-hji-manager.user.js` — insurance provider/manager script
- `torn-hji-client.user.js` — insured-player client script
- `README.md` — project documentation
- `LICENSE` — project license

---

# Manager

The Manager is intended for the person providing Happy Jump insurance, or someone managing policies on their behalf.

## Main features

### Dashboard

Shows:

- Total customers
- Active policies
- Policies due soon
- Open claims
- Cash payments received
- Cash claim payouts
- Net cash position
- Item payments received
- Item claim payouts
- Item income breakdown
- Item payout breakdown
- Net item position

Cash and item accounting are kept separate because the Manager does not assume an in-game cash value for items.

### Customers

Customers are stored using:

- Torn username
- Torn user ID

The Torn ID is used as the stable identifier.

Customers can also be created automatically when a valid incoming insurance payment is detected.

### Insurance tiers

Tiers are fully configurable.

Each tier can contain:

- Tier name
- Policy type
- Duration
- Coverage description
- DVD limit
- Cash price
- Alternative item
- Alternative item ID
- Item quantity
- Active/disabled state

Unused tiers can be deleted from inside the Tier editor.

A tier that is still linked to a policy cannot be deleted.

### Policies

Supports:

- Single-jump cover
- Monthly/time-based cover
- Active
- Due soon
- Expired
- Cancelled
- Used / Paid out

Single-jump policies can automatically move to a paid-out/used state after a successful claim payout.

### Payments

Payments can be recorded as:

- Cash
- Items

Payments can be:

- Added manually
- Edited after saving
- Linked directly to a policy
- Created automatically from an approved payment scan

Money-entry fields use formatted values such as:

`800,000.00`

instead of:

`800000`

---

# Incoming payment scanners

The Manager contains separate scanners for incoming **item** and **cash** payments.

Nothing is turned into a policy automatically.

The Manager always asks the provider to confirm a detected payment first.

## Item payment scanner

The item scanner checks Torn's **Item receive** log.

Current Torn log type used:

`4103 - Item receive`

The scanner:

- Looks only at incoming item transfers
- Matches received Torn Item IDs against active tier payment items
- Falls back to configured item names where needed
- Matches quantities against tier settings
- Ignores unrelated incoming items
- Can identify the sender
- Can create a customer if they do not already exist
- Creates the selected policy
- Records the item payment
- Links the payment to the policy

The normal scan uses:

- Last successful scan time
- 5-minute overlap

The recovery scan checks:

- Last 3 days

Processed Torn log IDs are remembered to prevent duplicate processing.

### Processed Item Scan Log

The Manager keeps an audit log of reviewed item transfers.

It records:

- Date
- Sender
- Torn ID
- Item
- Quantity
- Transfer message
- Action taken

Possible actions include:

- Created policy
- Ignored
- Later
- Legacy processed

Ignored/reviewed transfers can be reopened if a payment was classified incorrectly.

---

## Cash payment scanner

Cash scanning is separate from item scanning.

The Manager checks Torn money-transfer logs and keeps incoming **Money receive** entries.

It compares incoming cash amounts against the cash prices configured on active tiers.

For example:

`$800,000 received`

can be matched against a tier priced at:

`$800,000`

The provider is then asked whether to create the customer/policy.

The cash scanner can:

- Detect incoming cash transfers
- Match cash amounts to active tiers
- Handle multiple tiers using the same price
- Create a new customer
- Create a policy
- Record the cash payment
- Link the payment to the policy

Cash scanning also has:

- Last-successful-scan tracking
- 5-minute overlap
- 3-day recovery scan
- Separate processed-log history
- Reopen support

---

# Claims

The Client prepares claims and sends them to the insurance provider using Torn Mail.

The Manager can scan Torn Mail and import HJI claims.

Claim statuses include:

- Submitted
- Reviewing
- Approved
- Rejected
- Paid
- Closed

The Manager can:

- Open the original Torn Mail
- Open a trade with the claimant
- Record provider notes
- Record cash payouts
- Record item payouts
- Notify the claimant of status changes

Claim data is stored locally once imported, so the Torn Mail does not need to remain in the inbox permanently.

---

# Claim payouts

When a claim is marked **Paid**, the Manager records what was actually paid.

Supported payout methods:

- Cash
- Item

Cash payouts contribute to the Dashboard's cash profit/loss calculation.

Item payouts are tracked separately by item.

Example:

`5x Xanax received`
`2x Xanax paid out`

Net item position:

`+3x Xanax`

---

# Client

The Client is installed by the insured player.

## Main features

The Client can:

- Import policy/setup codes from a provider
- Store provider and policy details locally
- Display current cover
- Display policy status
- Show policy highlighting
- Prepare claims
- Open Torn Mail addressed to the provider
- Track claim status
- Sync policy status
- Show collapsible claim history
- Detect the Client user's Torn account safely
- Run on Tampermonkey and Torn PDA

The Client UI is:

- Draggable
- Resizable
- Scalable
- Mobile/PDA friendly

The minimum manual window size is approximately:

`150 x 150`

The **Size** button can switch to a compact preset of roughly:

`350 x 310`

The selected size is remembered locally.

---

# Client API key requirements

The Client does **not** require an API key for all features.

## No API key required

The Client can still:

- Import policies
- View cover
- View locally stored policies
- Prepare claims
- Open/send claim Torn Mail

## API key required

A Client API key is required for:

- **Detect My Torn Account**
- **Sync claim statuses**
- **Sync policy statuses**

The Client key builder requests the required Client permissions.

The Client does not expose the API key inside policy/setup codes.

---

# Manager API key

The Manager uses a Torn API key for features including:

- Account detection
- Torn Mail claim scanning
- Policy/status mail handling
- Incoming item log scanning
- Incoming cash log scanning

The Manager includes a custom-key builder in Settings.

The stored API key is kept locally by the userscript.

API keys are deliberately excluded from Manager backup exports.

---

# Provider identity

The Manager separates:

- **API account**
- **Policy provider**

These can be different.

This allows someone to run the Manager on their own Torn account while administering insurance on behalf of another provider.

Client setup codes and claim routing use the configured **Provider Name** and **Provider Torn ID**.

---

# Policy and claim sync

This project does not require a separate hosted backend.

Policy and claim status communication uses Torn Mail.

This keeps the Manager and Client independent while still allowing status updates to move between installations.

Once a status has been imported successfully, the Client/Manager keeps the information locally.

---

# Torn Mail claim format

The Manager recognises structured HJI claims.

Example:

```text
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

HJI does not silently send Torn Mail.

The player remains responsible for pressing Torn's Send button.

---

# Backup and restore

The Manager supports local JSON backup/export and restore.

Backups contain:

- Tiers
- Customers
- Policies
- Payments
- Claims
- Manager settings
- Scanner audit data

API keys are not exported.

This allows the Manager database to be moved to another device or restored after reinstalling the userscript.

---

# Storage

Manager and Client data are stored locally in the userscript/browser environment.

This includes policy records, claims, payment history and scanner state.

Because the project uses local storage, users should make regular Manager backups if the insurance database is important.

---

# Installation

## Tampermonkey

Install the appropriate raw userscript from the GitHub repository:

Manager:

`https://raw.githubusercontent.com/DooBiiE/Torn-Happy-Jump-Insurance/main/torn-hji-manager.user.js`

Client:

`https://raw.githubusercontent.com/DooBiiE/Torn-Happy-Jump-Insurance/main/torn-hji-client.user.js`

## Torn PDA

Use the same raw GitHub userscript URLs when adding the script to Torn PDA.

Both scripts are intended to share the same source file across Desktop/Tampermonkey and Torn PDA.

---

# Updates

Both scripts contain GitHub update/download metadata pointing to the raw files on the repository's `main` branch.

When publishing a new version:

1. Replace the appropriate `.user.js` file in the repository.
2. Confirm the `@version` value changed.
3. Commit the update to `main`.
4. Torn PDA/Tampermonkey can then retrieve the updated script.

---

# Safety / behaviour

HJI is a management helper.

It does not:

- Automatically send Torn Mail
- Automatically create insurance cover without provider confirmation
- Automatically pay claims
- Expose Manager API keys to clients
- Require a separate hosted database/backend

The provider remains in control of customer creation, policies, claims and payouts.

---

# Project status

Current development versions:

- Manager **v0.4.31**
- Client **v0.4.5**

The project is under active development.
