# Budget Plugin Development Guide

## Overview

The Budget plugin allows users to track spending against tag-based budget categories with support for rollovers between months.

## Architecture

### Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Plugin entry point, manifest, activation |
| `src/BudgetView.svelte` | Main UI component (1400+ lines) |
| `src/db.ts` | Database operations via SDK |
| `src/types.ts` | TypeScript type definitions |

### Database Tables

The plugin uses the `plugin_budget` schema with three tables:

**`plugin_budget.categories`**
- `category_id` - UUID primary key
- `month` - YYYY-MM format
- `type` - "income" or "expense"
- `name` - Category display name
- `expected` - Expected amount for the month
- `tags` - Array of tags to match transactions
- `require_all` - If true, transaction must have ALL tags
- `amount_sign` - "positive", "negative", or "any"
- `sort_order` - Display order within type

**`plugin_budget.rollovers`**
- `rollover_id` - UUID primary key
- `source_month` - Month the rollover is from
- `from_category` - Source category name
- `to_category` - Destination category name
- `to_month` - Month the rollover applies to
- `amount` - Amount being transferred

**`plugin_budget.ignored_tags`** (migration 3)
- `tag` - Primary key. Tags the user has said don't need a budget category (transfers, reimbursements).
- `created_at` - When it was ignored

Global, not month-scoped, and it only suppresses the unbudgeted check - it never
affects actuals.

### Coverage (migration 3)

One definition of "which categories did this transaction match", shared by the
UI, `tl doctor`, and agents. Matching mirrors `calculateActualsForMonth`: any/all
tags, optional `amount_sign`, bucketed by `transaction_date`.

- **`plugin_budget.coverage_all`** - view, every transaction with its matched
  categories, keyed by `month`. The shared implementation; query it directly
  when you need more than one month.
- **`plugin_budget.coverage(month)`** - table macro over that view for one
  `'YYYY-MM'`. Returns `transaction_id, transaction_date, description, amount,
  tags, account_name, matched_categories` (list, may be empty) and
  `match_count`. `match_count = 0` is unbudgeted, `>= 2` is double counted -
  which is sometimes deliberate, so the UI flags rather than corrects it.
- **`plugin_budget.doctor`** - view core reads to publish plugin checks. See below.

Both use `CREATE OR REPLACE`, so a later migration can revise them.

### The `doctor` view contract

Core discovers `<schema>.doctor` by convention, runs
`SELECT to_json(d) FROM plugin_budget.doctor d`, and reports each row as
`budget.<check_id>` in `tl doctor` and MCP. **Do not change these columns
without coordinating with core:**

| Column | Type | Notes |
|--------|------|-------|
| `check_id` | VARCHAR | `double_counted`, `unbudgeted_tags` |
| `name` | VARCHAR | Human label |
| `status` | VARCHAR | `pass` / `warning` / `error` |
| `message` | VARCHAR | One line |
| `details` | LIST(JSON) | Sample rows, capped at 50; NULL when passing |

Scope is the current month plus the two prior, and only months that actually
have categories - a month with nothing set up is "not set up", not "everything
unbudgeted". Month arithmetic uses `strftime(now()::TIMESTAMP, ...)`, never
`CURRENT_DATE` (the icu extension isn't loaded).

### SDK Usage

All database operations go through the SDK:
```typescript
// Read operations
const result = await sdk.query<unknown[]>(sql, params);

// Write operations
await sdk.execute(sql, params);
```

The plugin receives the SDK via props:
```typescript
const { sdk }: { sdk: PluginSDK } = $props();
```

## Key Features

### Month-Scoped Categories
Each month has its own complete set of categories. Categories are not inherited - users copy from a previous month when setting up a new one.

### Coverage Flagging
Transactions that matched two or more categories, or none, surface as a line
under the metrics row and a drill-down modal. Additive - it never changes the
actuals computation.

### Tag-Based Matching
Categories match transactions by tags. Options:
- Match ANY tag (default)
- Match ALL tags (`require_all: true`)
- Filter by amount sign (positive/negative/any)

### Rollovers
Users can transfer remaining budget from one category to another (same or different) for the next month. Rollovers are stored in the source month's data.

## Building

```bash
npm install
npm run build
```

Output: `dist/index.js`

## Local Testing

```bash
# Build the plugin
npm run build

# Install locally (from treeline CLI)
tl plugin install .

# Verify installation
ls ~/.treeline/plugins/budget/
```

## Release Process

```bash
# Tag and push
git tag v0.1.0
git push origin v0.1.0

# Create GitHub release with assets
gh release create v0.1.0 manifest.json dist/index.js --title "v0.1.0"
```

## UI Components

This plugin inlines all UI components (Modal, RowMenu, TagInput) rather than importing from shared. This is the standard pattern for community plugins.

### Modal Pattern
```svelte
{#if showModal}
  <div class="modal-overlay" onclick={closeModal}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <!-- content -->
    </div>
  </div>
{/if}
```

### RowMenu Pattern
```svelte
<div class="row-menu">
  <button class="row-menu-btn" onclick={toggleMenu}>&#8942;</button>
  {#if isOpen}
    <div class="row-menu-dropdown">
      <button class="menu-item" onclick={action}>Label</button>
    </div>
  {/if}
</div>
```

## Styling

Use CSS variables from the app theme:
- `--bg-primary`, `--bg-secondary`, `--bg-tertiary`
- `--text-primary`, `--text-secondary`, `--text-muted`
- `--border-primary`
- `--accent-primary`, `--accent-success`, `--accent-danger`, `--accent-warning`
- `--spacing-sm`, `--spacing-md`, `--spacing-lg`, `--spacing-xl`
- `--font-mono`
