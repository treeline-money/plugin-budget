import type { Plugin, PluginContext, PluginSDK, PluginMigration } from "@treeline-money/plugin-sdk";
import BudgetView from "./BudgetView.svelte";
import { mount, unmount } from "svelte";

// Database migrations - run in order by version when plugin loads
const migrations: PluginMigration[] = [
  {
    version: 1,
    name: "create_categories_table",
    up: `
      CREATE TABLE IF NOT EXISTS plugin_budget.categories (
        category_id VARCHAR PRIMARY KEY,
        month VARCHAR NOT NULL,
        type VARCHAR NOT NULL,
        name VARCHAR NOT NULL,
        expected DECIMAL(12,2) NOT NULL DEFAULT 0,
        tags VARCHAR[] DEFAULT [],
        require_all BOOLEAN DEFAULT FALSE,
        amount_sign VARCHAR,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_budget_categories_month
        ON plugin_budget.categories(month)
    `,
  },
  {
    version: 2,
    name: "create_rollovers_table",
    up: `
      CREATE TABLE IF NOT EXISTS plugin_budget.rollovers (
        rollover_id VARCHAR PRIMARY KEY,
        source_month VARCHAR NOT NULL,
        from_category VARCHAR NOT NULL,
        to_category VARCHAR NOT NULL,
        to_month VARCHAR NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_budget_rollovers_source
        ON plugin_budget.rollovers(source_month);
      CREATE INDEX IF NOT EXISTS idx_budget_rollovers_target
        ON plugin_budget.rollovers(to_month)
    `,
  },
  {
    version: 3,
    name: "create_coverage_and_doctor",
    // Coverage: which budget categories each transaction matched, using the
    // rules the UI applies (any/all tags, optional amount_sign, bucketed by
    // transaction_date). Defined once in SQL so the view, `tl doctor`, and
    // agents all agree.
    //
    // NOTE: the migration runner splits `up` on ';', so no single statement
    // may contain one.
    up: `
      CREATE TABLE IF NOT EXISTS plugin_budget.ignored_tags (
        tag VARCHAR PRIMARY KEY,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE OR REPLACE VIEW plugin_budget.coverage_all AS
      SELECT
        strftime(t.transaction_date, '%Y-%m') AS month,
        t.transaction_id,
        t.transaction_date,
        t.description,
        t.amount,
        COALESCE(t.tags, []::VARCHAR[]) AS tags,
        t.account_name,
        COALESCE(list_sort(list(c.name) FILTER (WHERE c.name IS NOT NULL)), []::VARCHAR[]) AS matched_categories,
        COUNT(c.name) AS match_count
      FROM transactions t
      LEFT JOIN plugin_budget.categories c
        ON c.month = strftime(t.transaction_date, '%Y-%m')
       AND len(c.tags) > 0
       AND (CASE WHEN c.require_all
                 THEN list_has_all(COALESCE(t.tags, []::VARCHAR[]), c.tags)
                 ELSE list_has_any(COALESCE(t.tags, []::VARCHAR[]), c.tags) END)
       AND (CASE c.amount_sign
              WHEN 'positive' THEN t.amount > 0
              WHEN 'negative' THEN t.amount < 0
              ELSE TRUE END)
      GROUP BY ALL;
      CREATE OR REPLACE MACRO plugin_budget.coverage(m) AS TABLE
        SELECT transaction_id, transaction_date, description, amount, tags,
               account_name, matched_categories, match_count
        FROM plugin_budget.coverage_all
        WHERE month = m;
      CREATE OR REPLACE VIEW plugin_budget.doctor AS
      WITH scope AS (
        SELECT printf('%04d-%02d', CAST(FLOOR((ym - k) / 12) AS BIGINT), (ym - k) % 12 + 1) AS month
        FROM (SELECT CAST(strftime(now()::TIMESTAMP, '%Y') AS BIGINT) * 12
                   + CAST(strftime(now()::TIMESTAMP, '%m') AS BIGINT) - 1 AS ym) anchor,
             (SELECT UNNEST([0, 1, 2]) AS k) offsets
      ),
      budgeted AS (
        SELECT DISTINCT c.month
        FROM plugin_budget.categories c
        JOIN scope s ON s.month = c.month
      ),
      cov AS (
        SELECT a.* FROM plugin_budget.coverage_all a JOIN budgeted b ON b.month = a.month
      ),
      doubled AS (SELECT * FROM cov WHERE match_count > 1),
      doubled_sample AS (
        SELECT CAST(struct_pack(transaction_date, description, amount, matched_categories) AS JSON) AS entry
        FROM doubled ORDER BY ABS(amount) DESC LIMIT 50
      ),
      unbudgeted AS (
        SELECT u.tag, COUNT(*) AS txn_count, ROUND(SUM(u.amount), 2) AS total
        FROM (SELECT UNNEST(tags) AS tag, amount FROM cov WHERE match_count = 0 AND len(tags) > 0) u
        WHERE u.tag NOT IN (SELECT tag FROM plugin_budget.ignored_tags)
        GROUP BY u.tag
      ),
      unbudgeted_sample AS (
        SELECT CAST(struct_pack(tag, txn_count, total) AS JSON) AS entry
        FROM unbudgeted ORDER BY ABS(total) DESC LIMIT 50
      ),
      counts AS (
        SELECT
          (SELECT COUNT(*) FROM budgeted) AS months_set_up,
          (SELECT COUNT(*) FROM doubled) AS doubled_txns,
          (SELECT COUNT(*) FROM unbudgeted) AS unbudgeted_tags,
          (SELECT COALESCE(SUM(txn_count), 0) FROM unbudgeted) AS unbudgeted_txns
      )
      SELECT
        'double_counted' AS check_id,
        'Budget double counting' AS name,
        CASE WHEN doubled_txns = 0 THEN 'pass' ELSE 'warning' END AS status,
        CASE WHEN months_set_up = 0 THEN 'No budget months set up in the last 3 months'
             WHEN doubled_txns = 0 THEN 'No transactions matched more than one budget category in the last 3 months'
             ELSE doubled_txns || ' transaction(s) matched more than one budget category in the last 3 months'
        END AS message,
        CASE WHEN doubled_txns = 0 THEN NULL ELSE (SELECT list(entry) FROM doubled_sample) END AS details
      FROM counts
      UNION ALL
      SELECT
        'unbudgeted_tags',
        'Unbudgeted tags',
        CASE WHEN unbudgeted_tags = 0 THEN 'pass' ELSE 'warning' END,
        CASE WHEN months_set_up = 0 THEN 'No budget months set up in the last 3 months'
             WHEN unbudgeted_tags = 0 THEN 'Every tagged transaction matched a budget category in the last 3 months'
             ELSE unbudgeted_tags || ' tag(s) on ' || unbudgeted_txns || ' transaction(s) matched no budget category in the last 3 months'
        END,
        CASE WHEN unbudgeted_tags = 0 THEN NULL ELSE (SELECT list(entry) FROM unbudgeted_sample) END
      FROM counts
    `,
  },
];

export const plugin: Plugin = {
  manifest: {
    id: "budget",
    name: "Budget",
    version: "0.3.0",
    description: "Track spending against tag-based budget categories with rollovers",
    author: "Treeline",
    permissions: {
      read: ["transactions", "accounts"],
      schemaName: "plugin_budget",
    },
  },

  migrations,

  activate(context: PluginContext) {
    // Register view with mount function (community plugin pattern)
    context.registerView({
      id: "budget",
      name: "Budget",
      icon: "piggy-bank",
      mount: (target: HTMLElement, props: { sdk: PluginSDK }) => {
        const instance = mount(BudgetView, {
          target,
          props,
        });

        return () => {
          unmount(instance);
        };
      },
    });

    // Add sidebar item
    context.registerSidebarItem({
      sectionId: "main",
      id: "budget",
      label: "Budget",
      icon: "piggy-bank",
      viewId: "budget",
    });

    // Register command for quick access
    context.registerCommand({
      id: "budget.open",
      name: "View Budget",
      description: "Open the budget tracker",
      execute: () => {
        context.openView("budget");
      },
    });

    console.log("Budget plugin loaded");
  },

  deactivate() {
    console.log("Budget plugin deactivated");
  },
};
