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
];

export const plugin: Plugin = {
  manifest: {
    id: "budget",
    name: "Budget",
    version: "0.1.0",
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
