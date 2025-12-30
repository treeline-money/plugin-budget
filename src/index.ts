import type { Plugin, PluginContext, PluginSDK } from "@treeline-money/plugin-sdk";
import BudgetView from "./BudgetView.svelte";
import { mount, unmount } from "svelte";

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
