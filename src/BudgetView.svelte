<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { PluginSDK } from "@treeline-money/plugin-sdk";
  import type { Snippet } from "svelte";
  import type { BudgetCategory, BudgetActual, BudgetType, AmountSign, Transaction, Transfer } from "./types";
  import * as budgetDb from "./db";

  // Props from plugin SDK
  const { sdk }: { sdk: PluginSDK } = $props();

  // State
  let categories = $state<BudgetCategory[]>([]);
  let actuals = $state<BudgetActual[]>([]);
  let isLoading = $state(true);
  let error = $state<string | null>(null);

  // Month selection
  let availableMonths = $state<string[]>([]);
  let selectedMonth = $state<string>("");
  let showCopyFromPrevious = $state(false);
  let copySourceMonth = $state<string | null>(null);
  let monthsWithData = $state<string[]>([]);

  // Current month helper
  function getCurrentMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  let isCurrentMonth = $derived(selectedMonth === getCurrentMonth());

  // Account filtering
  let allAccounts = $state<string[]>([]);
  let selectedAccounts = $state<string[]>([]);

  // Navigation
  let cursorIndex = $state(0);
  let containerEl: HTMLDivElement | null = null;

  // Transaction drill-down
  let showTransactions = $state(false);
  let drillDownCategory = $state<BudgetActual | null>(null);
  let drillDownTransactions = $state<Transaction[]>([]);
  let drillDownLoading = $state(false);

  // Row menu state
  let menuOpenForId = $state<string | null>(null);

  function closeMenu() {
    menuOpenForId = null;
  }

  function toggleMenu(id: string, e: MouseEvent) {
    e.stopPropagation();
    menuOpenForId = menuOpenForId === id ? null : id;
  }

  // Editor state
  let isEditing = $state(false);
  let editingCategory = $state<BudgetCategory | null>(null);
  let editorForm = $state({
    type: "expense" as BudgetType,
    category: "",
    expected: 0,
    tags: "",
    require_all: false,
    amount_sign: null as AmountSign | null,
  });

  // Transfer state
  let incomingTransfers = $state<Transfer[]>([]);
  let outgoingTransfers = $state<Transfer[]>([]);

  // Reset modal state
  let showResetModal = $state(false);
  let resetSourceMonth = $state<string | null>(null);

  // Transfer modal state
  let showTransferModal = $state(false);
  let transferSourceCategory = $state<string>("");
  let transferSourceVariance = $state<number>(0);
  let transferStorageMonth = $state<string>("");
  let transferTargetCategory = $state<string>("");
  let isEditingIncoming = $state(false);
  interface TransferRow {
    id: string;
    toCategory: string;
    amount: number;
  }
  let transferRows = $state<TransferRow[]>([]);
  let isEditingTransfers = $state(false);

  // All known tags for autocomplete
  let allTags = $state<string[]>([]);

  // Trend data
  interface TrendData {
    month: string;
    actual: number;
  }
  let allCategoryTrends = $state<Map<string, TrendData[]>>(new Map());

  // TagInput autocomplete state
  let tagAutocompleteIndex = $state(-1);

  // Derived state
  let incomeActuals = $derived(actuals.filter(a => a.type === "income"));
  let budgetActuals = $derived(actuals.filter(a => a.type === "expense"));
  let allActuals = $derived([...incomeActuals, ...budgetActuals]);

  let currentActual = $derived(allActuals[cursorIndex]);
  let currentCategory = $derived(categories.find(c => c.id === currentActual?.id));

  let categoryTrend = $derived(currentCategory ? (allCategoryTrends.get(currentCategory.id) || []) : []);

  let currentIncomingTransfers = $derived(
    currentActual ? incomingTransfers.filter(t => t.toCategory === currentActual.category) : []
  );
  let currentOutgoingTransfers = $derived(
    currentActual ? outgoingTransfers.filter(t => t.fromCategory === currentActual.category) : []
  );
  let currentIncomingNet = $derived(roundToCents(currentIncomingTransfers.reduce((sum, t) => sum + t.amount, 0)));
  let currentOutgoingNet = $derived(roundToCents(currentOutgoingTransfers.reduce((sum, t) => sum + t.amount, 0)));

  let incomeSummary = $derived.by(() => {
    const expected = incomeActuals.reduce((sum, a) => sum + a.expected, 0);
    const actual = incomeActuals.reduce((sum, a) => sum + a.actual, 0);
    const percent = expected > 0 ? Math.floor((actual / expected) * 100) : 0;
    return { expected, actual, percent };
  });

  let budgetSummary = $derived.by(() => {
    const expected = budgetActuals.reduce((sum, a) => sum + a.expected, 0);
    const actual = budgetActuals.reduce((sum, a) => sum + a.actual, 0);
    const percent = expected > 0 ? Math.floor((actual / expected) * 100) : 0;
    return { expected, actual, percent };
  });

  let remainingSummary = $derived.by(() => {
    const expected = incomeSummary.expected - budgetSummary.expected;
    const actual = incomeSummary.actual - budgetSummary.actual;
    const percent = expected > 0 ? Math.floor((actual / expected) * 100) : (actual > 0 ? 100 : 0);
    return { expected, actual, percent };
  });

  // Month pacing - compare % of budget spent vs % of month elapsed
  let monthPacing = $derived.by(() => {
    // Parse selectedMonth (YYYY-MM format) to get days info
    const [year, month] = selectedMonth.split('-').map(Number);
    const lastDay = new Date(year, month, 0); // Last day of the month
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const totalDays = lastDay.getDate();
    const dayOfMonth = Math.min(Math.max(today.getDate(), 1), totalDays);

    // Determine month type
    const selectedDate = new Date(year, month - 1, 1);
    const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month - 1;
    const isPastMonth = selectedDate < currentMonthStart;
    const isFutureMonth = selectedDate > currentMonthStart;

    // Time elapsed: 100% for past, 0% for future, actual for current
    const monthElapsedPercent = isPastMonth ? 100 : (isFutureMonth ? 0 : Math.round((dayOfMonth / totalDays) * 100));
    const daysRemaining = isCurrentMonth ? totalDays - dayOfMonth : 0;

    // Budget spent percent (expenses only)
    const spentPercent = budgetSummary.percent;

    // Pacing: negative means ahead (spent less than time elapsed), positive means behind
    const pacingDiff = spentPercent - monthElapsedPercent;

    return {
      monthElapsedPercent,
      daysRemaining,
      spentPercent,
      pacingDiff,
      isCurrentMonth,
      isPastMonth,
      isFutureMonth,
      totalDays,
      dayOfMonth
    };
  });

  // Tag autocomplete suggestions
  let tagSuggestions = $derived.by(() => {
    if (!editorForm.tags || allTags.length === 0) return [];
    const parts = editorForm.tags.split(",");
    const partial = parts[parts.length - 1].trim().toLowerCase();
    if (!partial || partial.length < 1) return [];
    if (allTags.some(tag => tag.toLowerCase() === partial)) return [];
    const enteredTags = parts.slice(0, -1).map(t => t.trim().toLowerCase());
    return allTags
      .filter(tag => {
        const tagLower = tag.toLowerCase();
        if (enteredTags.includes(tagLower)) return false;
        return tagLower.startsWith(partial);
      })
      .slice(0, 8);
  });

  async function saveCategoriesToDb(cats: BudgetCategory[]): Promise<void> {
    if (!selectedMonth) return;
    await budgetDb.saveAllCategories(sdk, selectedMonth, cats);
  }

  async function copyFromSourceMonth(): Promise<void> {
    if (!selectedMonth || !copySourceMonth) return;
    try {
      const copiedCategories = await budgetDb.copyFromMonth(sdk, copySourceMonth, selectedMonth);
      if (copiedCategories.length > 0) {
        categories = copiedCategories;
        showCopyFromPrevious = false;
        copySourceMonth = null;
        await calculateActuals();
      }
    } catch (e) {
      console.error("Failed to copy from source month:", e);
    }
  }

  function findNearestMonth(targetMonth: string, availableMonths: string[]): string | null {
    if (availableMonths.length === 0) return null;
    const targetDate = new Date(targetMonth + "-01");
    let nearest: string | null = null;
    let nearestDistance = Infinity;
    for (const month of availableMonths) {
      if (month === targetMonth) continue;
      const monthDate = new Date(month + "-01");
      const distance = Math.abs(monthDate.getTime() - targetDate.getTime());
      const isMoreRecent = monthDate > targetDate;
      const adjustedDistance = isMoreRecent ? distance * 0.9 : distance;
      if (adjustedDistance < nearestDistance) {
        nearestDistance = adjustedDistance;
        nearest = month;
      }
    }
    return nearest;
  }

  async function startFresh(): Promise<void> {
    if (!selectedMonth) return;
    categories = [];
    showCopyFromPrevious = false;
    copySourceMonth = null;
  }

  async function openResetModal(): Promise<void> {
    monthsWithData = await budgetDb.getMonthsWithData(sdk);
    const otherMonths = monthsWithData.filter(m => m !== selectedMonth);
    const prevMonth = budgetDb.getPreviousMonth(selectedMonth);
    resetSourceMonth = otherMonths.includes(prevMonth) ? prevMonth : findNearestMonth(selectedMonth, otherMonths);
    showResetModal = true;
  }

  function closeResetModal(): void {
    showResetModal = false;
    resetSourceMonth = null;
  }

  async function resetFromMonth(): Promise<void> {
    if (!selectedMonth || !resetSourceMonth) return;
    try {
      const copiedCategories = await budgetDb.copyFromMonth(sdk, resetSourceMonth, selectedMonth);
      await budgetDb.deleteMonthRollovers(sdk, selectedMonth);
      categories = copiedCategories;
      outgoingTransfers = [];
      closeResetModal();
      await calculateActuals();
      await loadAllTrends();
    } catch (e) {
      console.error("Failed to reset from month:", e);
    }
  }

  async function deleteBudget(): Promise<void> {
    if (!selectedMonth) return;
    await budgetDb.saveAllCategories(sdk, selectedMonth, []);
    await budgetDb.deleteMonthRollovers(sdk, selectedMonth);
    categories = [];
    outgoingTransfers = [];
    closeResetModal();
    await loadCategories();
  }

  async function loadAllAccounts() {
    const result = await sdk.query<unknown[]>(`SELECT DISTINCT account_name FROM transactions WHERE account_name IS NOT NULL AND account_name != '' ORDER BY account_name`);
    allAccounts = result.map(r => r[0] as string);
  }

  async function loadAllTags() {
    const result = await sdk.query<unknown[]>(`
      WITH unnested AS (
        SELECT UNNEST(tags) as tag FROM transactions WHERE tags IS NOT NULL AND len(tags) > 0
      )
      SELECT tag, COUNT(*) as cnt FROM unnested GROUP BY tag ORDER BY cnt DESC
    `);
    allTags = result.map(r => r[0] as string);
  }

  async function loadCategoriesFromDb() {
    if (!selectedMonth) return;
    try {
      const monthData = await budgetDb.loadMonthData(sdk, selectedMonth);
      if (monthData.categories.length === 0) {
        monthsWithData = await budgetDb.getMonthsWithData(sdk);
        const otherMonths = monthsWithData.filter(m => m !== selectedMonth);
        if (otherMonths.length === 0) {
          categories = [];
          showCopyFromPrevious = false;
          copySourceMonth = null;
        } else {
          categories = [];
          copySourceMonth = findNearestMonth(selectedMonth, otherMonths);
          showCopyFromPrevious = true;
        }
      } else {
        categories = monthData.categories;
        showCopyFromPrevious = false;
        copySourceMonth = null;
        monthsWithData = [];
      }
      outgoingTransfers = monthData.outgoingRollovers;
      incomingTransfers = monthData.incomingRollovers;
    } catch (e) {
      console.error("Failed to load categories:", e);
      categories = [];
    }
  }

  async function loadCategories() {
    await loadCategoriesFromDb();
  }

  function buildAccountFilterWithParams(): { sql: string; params: (string | number | boolean | null)[] } {
    if (selectedAccounts.length === 0) return { sql: "", params: [] };
    const placeholders = selectedAccounts.map(() => '?').join(', ');
    return {
      sql: `AND account_name IN (${placeholders})`,
      params: [...selectedAccounts]
    };
  }

  function buildTagConditionWithParams(tags: string[], requireAll: boolean): { sql: string; params: (string | number | boolean | null)[] } {
    if (requireAll) {
      const conditions = tags.map(() => `list_contains(tags, ?)`);
      return { sql: conditions.join(' AND '), params: [...tags] };
    } else {
      const placeholders = tags.map(() => '?').join(', ');
      return { sql: `list_has_any(tags, list_value(${placeholders}))`, params: [...tags] };
    }
  }

  async function calculateActualsForMonth(month: string): Promise<BudgetActual[]> {
    if (!month || categories.length === 0) return [];
    const accountFilter = buildAccountFilterWithParams();
    const results = await Promise.all(categories.map(async (cat) => {
      try {
        const tagCondition = buildTagConditionWithParams(cat.tags, cat.require_all);
        const amountCondition = cat.amount_sign === "positive" ? "AND amount > 0" : cat.amount_sign === "negative" ? "AND amount < 0" : "";
        const sql = `SELECT COALESCE(ABS(SUM(amount)), 0) as total FROM transactions
          WHERE strftime('%Y-%m', transaction_date) = ?
          AND ${tagCondition.sql} ${amountCondition} ${accountFilter.sql}`;
        const params = [month, ...tagCondition.params, ...accountFilter.params];
        const result = await sdk.query<unknown[]>(sql, params);
        return { id: cat.id, total: (result[0]?.[0] as number) || 0 };
      } catch {
        return { id: cat.id, total: 0 };
      }
    }));
    const totalsById = new Map(results.map(r => [r.id, r.total]));
    return categories.map(cat => {
      const actual = totalsById.get(cat.id) || 0;
      const variance = cat.type === "income" ? actual - cat.expected : cat.expected - actual;
      const percentUsed = cat.expected > 0 ? Math.floor((actual / cat.expected) * 100) : (actual > 0 ? 100 : 0);
      return { id: cat.id, type: cat.type, category: cat.category, expected: cat.expected, actual, variance, percentUsed };
    });
  }

  async function calculateActuals() {
    actuals = await calculateActualsForMonth(selectedMonth);
  }

  async function loadAllTrends() {
    if (categories.length === 0) {
      allCategoryTrends = new Map();
      return;
    }
    const accountFilter = buildAccountFilterWithParams();
    const results = await Promise.all(categories.map(async (cat) => {
      try {
        const tagCondition = buildTagConditionWithParams(cat.tags, cat.require_all);
        const amountCondition = cat.amount_sign === "positive" ? "AND amount > 0" : cat.amount_sign === "negative" ? "AND amount < 0" : "";
        const sql = `SELECT strftime('%Y-%m', transaction_date) as month, COALESCE(ABS(SUM(amount)), 0) as total
          FROM transactions
          WHERE ${tagCondition.sql} ${amountCondition} ${accountFilter.sql}
          GROUP BY month
          ORDER BY month DESC
          LIMIT 6`;
        const params = [...tagCondition.params, ...accountFilter.params];
        const result = await sdk.query<unknown[]>(sql, params);
        const trends: TrendData[] = result.map(row => ({
          month: row[0] as string,
          actual: row[1] as number
        }));
        return { categoryId: cat.id, trends };
      } catch {
        return { categoryId: cat.id, trends: [] };
      }
    }));
    const trendsMap = new Map<string, TrendData[]>();
    for (const { categoryId, trends } of results) {
      trends.sort((a, b) => a.month.localeCompare(b.month));
      trendsMap.set(categoryId, trends);
    }
    allCategoryTrends = trendsMap;
  }

  let initialLoadComplete = false;

  async function loadAll() {
    isLoading = true;
    error = null;
    try {
      const result = await sdk.query<unknown[]>(`SELECT DISTINCT strftime('%Y-%m', transaction_date) as month FROM transactions ORDER BY month DESC`);
      const transactionMonths = result.map(r => r[0] as string);
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const nextMonthStr = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`;
      const allMonths = new Set([nextMonthStr, currentMonth, ...transactionMonths]);
      availableMonths = Array.from(allMonths).sort().reverse();
      const targetMonth = currentMonth;
      await Promise.all([loadAllTags(), loadAllAccounts()]);
      selectedMonth = targetMonth;
      await loadCategories();
      await Promise.all([calculateActuals(), loadAllTrends()]);
      initialLoadComplete = true;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load budget data";
    } finally {
      isLoading = false;
    }
  }

  async function loadTransactionsForCategory(cat: BudgetActual) {
    drillDownCategory = cat;
    drillDownLoading = true;
    showTransactions = true;
    const category = categories.find(c => c.id === cat.id);
    if (!category) { drillDownLoading = false; return; }
    const accountFilter = buildAccountFilterWithParams();
    const tagCondition = buildTagConditionWithParams(category.tags, category.require_all);
    const amountCondition = category.amount_sign === "positive" ? "AND amount > 0" : category.amount_sign === "negative" ? "AND amount < 0" : "";
    try {
      const sql = `SELECT transaction_id, transaction_date, description, amount, tags, account_name
        FROM transactions
        WHERE strftime('%Y-%m', transaction_date) = ?
        AND ${tagCondition.sql} ${amountCondition} ${accountFilter.sql}
        ORDER BY transaction_date DESC`;
      const params = [selectedMonth, ...tagCondition.params, ...accountFilter.params];
      const result = await sdk.query<unknown[]>(sql, params);
      drillDownTransactions = result.map(row => ({ transaction_id: row[0] as string, transaction_date: row[1] as string, description: row[2] as string, amount: row[3] as number, tags: (row[4] as string[]) || [], account_name: row[5] as string }));
    } catch {
      drillDownTransactions = [];
    } finally {
      drillDownLoading = false;
    }
  }

  function closeDrillDown() {
    showTransactions = false;
    drillDownCategory = null;
    drillDownTransactions = [];
    containerEl?.focus();
  }

  function handleModalEdit() {
    const cat = categories.find(c => c.id === drillDownCategory?.id);
    closeDrillDown();
    if (cat) startEditCategory(cat);
  }

  function handleModalDelete() {
    const cat = categories.find(c => c.id === drillDownCategory?.id);
    closeDrillDown();
    if (cat) deleteCategory(cat);
  }

  function startAddCategory(type: BudgetType) {
    editingCategory = null;
    editorForm = { type, category: "", expected: 0, tags: "", require_all: false, amount_sign: null };
    isEditing = true;
  }

  function startEditCategory(cat: BudgetCategory) {
    editingCategory = cat;
    editorForm = { type: cat.type, category: cat.category, expected: cat.expected, tags: cat.tags.join(", "), require_all: cat.require_all, amount_sign: cat.amount_sign };
    isEditing = true;
  }

  function cancelEdit() {
    isEditing = false;
    editingCategory = null;
    containerEl?.focus();
  }

  async function saveCategory() {
    const tags = editorForm.tags.split(",").map(t => t.trim()).filter(t => t);
    if (!editorForm.category.trim() || tags.length === 0 || !selectedMonth) return;
    const categoryId = editingCategory?.id ?? crypto.randomUUID();
    const newCategory: BudgetCategory = { id: categoryId, type: editorForm.type, category: editorForm.category.trim(), expected: editorForm.expected, tags, require_all: editorForm.require_all, amount_sign: editorForm.amount_sign };
    let updatedCategories: BudgetCategory[];
    if (editingCategory) {
      const editId = editingCategory.id;
      updatedCategories = categories.map(c => c.id === editId ? newCategory : c);
    } else {
      updatedCategories = [...categories, newCategory];
    }
    await budgetDb.saveAllCategories(sdk, selectedMonth, updatedCategories);
    cancelEdit();
    await loadCategories();
    await calculateActuals();
  }

  async function deleteCategory(cat: BudgetCategory) {
    if (!selectedMonth) return;
    const updatedCategories = categories.filter(c => c.id !== cat.id);
    await budgetDb.saveAllCategories(sdk, selectedMonth, updatedCategories);
    await loadCategories();
    await Promise.all([calculateActuals(), loadAllTrends()]);
  }

  function formatCurrency(amount: number): string {
    return sdk.currency.format(amount);
  }

  function formatCurrencyCents(amount: number): string {
    return sdk.currency.format(amount);
  }

  function roundToCents(amount: number): number {
    return Math.round(amount * 100) / 100;
  }

  function formatAmount(amount: number): string {
    return sdk.currency.formatAmount(Math.abs(amount));
  }

  function formatMonth(monthStr: string): string {
    if (!monthStr) return "";
    const [year, month] = monthStr.split("-");
    const date = new Date(parseInt(year), parseInt(month) - 1, 1);
    return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }

  function formatMonthShort(monthStr: string): string {
    if (!monthStr) return "";
    const [year, month] = monthStr.split("-");
    const date = new Date(parseInt(year), parseInt(month) - 1, 1);
    return date.toLocaleDateString("en-US", { month: "short" });
  }

  function getStatusColor(actual: BudgetActual): string {
    if (actual.type === "income") return actual.percentUsed >= 100 ? "var(--accent-success, #22c55e)" : "var(--text-muted)";
    if (actual.percentUsed > 100) return "var(--accent-danger, #ef4444)";
    if (actual.percentUsed > 90) return "var(--accent-warning, #f59e0b)";
    return "var(--accent-success, #22c55e)";
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (isEditing || showTransactions || showTransferModal) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      moveCategory(e.key === "ArrowUp" ? "up" : "down");
      return;
    }
    switch(e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        if (cursorIndex < allActuals.length - 1) cursorIndex++;
        scrollToCursor();
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        if (cursorIndex > 0) cursorIndex--;
        scrollToCursor();
        break;
      case "Enter":
        e.preventDefault();
        if (currentActual) loadTransactionsForCategory(currentActual);
        break;
      case "e":
        e.preventDefault();
        if (currentCategory) startEditCategory(currentCategory);
        break;
      case "d":
        e.preventDefault();
        if (currentCategory) deleteCategory(currentCategory);
        break;
      case "a":
        e.preventDefault();
        startAddCategory("expense");
        break;
      case "h":
      case "ArrowLeft":
        e.preventDefault();
        cycleMonth(1);
        break;
      case "l":
      case "ArrowRight":
        e.preventDefault();
        cycleMonth(-1);
        break;
      case "g":
        e.preventDefault();
        cursorIndex = 0;
        scrollToCursor();
        break;
      case "G":
        e.preventDefault();
        cursorIndex = allActuals.length - 1;
        scrollToCursor();
        break;
      case "t":
        e.preventDefault();
        goToCurrentMonth();
        break;
    }
  }

  function cycleMonth(delta: number) {
    const idx = availableMonths.indexOf(selectedMonth);
    const newIdx = idx + delta;
    if (newIdx >= 0 && newIdx < availableMonths.length) {
      selectedMonth = availableMonths[newIdx];
    }
  }

  function goToCurrentMonth() {
    selectedMonth = getCurrentMonth();
  }

  function getNextMonth(month: string): string {
    const [year, m] = month.split("-").map(Number);
    const nextDate = new Date(year, m, 1);
    return `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}`;
  }

  function getPrevMonth(month: string): string {
    const [year, m] = month.split("-").map(Number);
    const prevDate = new Date(year, m - 2, 1);
    return `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
  }

  function generateTransferId(): string {
    return `transfer-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  function openTransferModal(actual: BudgetActual, e: MouseEvent) {
    e.stopPropagation();
    transferSourceCategory = actual.category;
    const incomingRollover = incomingTransfers
      .filter(t => t.toCategory === actual.category)
      .reduce((sum, t) => sum + t.amount, 0);
    const effectiveVariance = roundToCents(actual.variance + incomingRollover);
    transferSourceVariance = effectiveVariance;
    transferStorageMonth = selectedMonth;
    transferTargetCategory = "";
    isEditingIncoming = false;
    isEditingTransfers = false;
    const existingTransfers = outgoingTransfers.filter(t => t.fromCategory === actual.category);
    if (existingTransfers.length > 0) {
      isEditingTransfers = true;
      transferRows = existingTransfers.map(t => ({
        id: t.id,
        toCategory: t.toCategory,
        amount: roundToCents(t.amount),
      }));
    } else {
      transferRows = [{
        id: generateTransferId(),
        toCategory: actual.category,
        amount: effectiveVariance,
      }];
    }
    showTransferModal = true;
  }

  function openEditIncomingTransfers(categoryName: string, e: MouseEvent) {
    e.stopPropagation();
    const transfers = incomingTransfers.filter(t => t.toCategory === categoryName);
    if (transfers.length === 0) return;
    const sourceCategories = [...new Set(transfers.map(t => t.fromCategory))];
    transferSourceCategory = sourceCategories[0];
    transferSourceVariance = 0;
    transferStorageMonth = getPrevMonth(selectedMonth);
    transferTargetCategory = categoryName;
    isEditingIncoming = true;
    isEditingTransfers = true;
    transferRows = transfers.map(t => ({
      id: t.id,
      toCategory: t.toCategory,
      amount: roundToCents(t.amount),
    }));
    showTransferModal = true;
  }

  function closeTransferModal() {
    showTransferModal = false;
    transferSourceCategory = "";
    transferSourceVariance = 0;
    transferStorageMonth = "";
    transferTargetCategory = "";
    isEditingIncoming = false;
    transferRows = [];
    isEditingTransfers = false;
    containerEl?.focus();
  }

  function addTransferRow() {
    transferRows = [...transferRows, {
      id: generateTransferId(),
      toCategory: transferSourceCategory,
      amount: 0,
    }];
  }

  function removeTransferRow(id: string) {
    transferRows = transferRows.filter(r => r.id !== id);
  }

  let availableTransferCategories = $derived(budgetActuals.map(a => a.category));
  let totalAllocated = $derived(transferRows.reduce((sum, r) => sum + (r.amount || 0), 0));
  let remainingToAllocate = $derived(transferSourceVariance - totalAllocated);

  async function saveTransfers() {
    if (!transferSourceCategory || !transferStorageMonth) return;
    const toMonth = getNextMonth(transferStorageMonth);
    const existingRollovers = await budgetDb.loadOutgoingRollovers(sdk, transferStorageMonth);
    const otherRollovers = existingRollovers.filter(t => t.fromCategory !== transferSourceCategory);
    const newRollovers: Transfer[] = transferRows
      .filter(r => r.amount !== 0)
      .map(r => ({
        id: r.id,
        fromCategory: transferSourceCategory,
        toCategory: r.toCategory,
        amount: roundToCents(r.amount),
      }));
    const allRollovers = [...otherRollovers, ...newRollovers];
    await budgetDb.saveMonthRollovers(sdk, transferStorageMonth, toMonth, allRollovers);
    await loadCategories();
    closeTransferModal();
  }

  async function removeAllTransfers() {
    if (!transferStorageMonth) return;
    const existingRollovers = await budgetDb.loadOutgoingRollovers(sdk, transferStorageMonth);
    const toMonth = getNextMonth(transferStorageMonth);
    let remainingRollovers: Transfer[];
    if (isEditingIncoming) {
      if (!transferTargetCategory) return;
      remainingRollovers = existingRollovers.filter(t => t.toCategory !== transferTargetCategory);
    } else {
      if (!transferSourceCategory) return;
      remainingRollovers = existingRollovers.filter(t => t.fromCategory !== transferSourceCategory);
    }
    await budgetDb.saveMonthRollovers(sdk, transferStorageMonth, toMonth, remainingRollovers);
    await loadCategories();
    closeTransferModal();
  }

  function scrollToCursor() {
    setTimeout(() => {
      document.querySelector(`[data-index="${cursorIndex}"]`)?.scrollIntoView({ block: "nearest" });
    }, 0);
  }

  function handleRowClick(index: number) {
    cursorIndex = index;
    containerEl?.focus();
  }

  function handleRowDoubleClick(index: number) {
    const actual = index < incomeActuals.length
      ? incomeActuals[index]
      : budgetActuals[index - incomeActuals.length];
    if (actual) {
      loadTransactionsForCategory(actual);
    }
  }

  async function moveCategory(direction: "up" | "down") {
    if (!currentCategory) return;
    const type = currentCategory.type;
    const typeCats = [...categories.filter(c => c.type === type)];
    const currentIndex = typeCats.findIndex(c => c.id === currentCategory.id);
    if (currentIndex === -1) return;
    const newIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= typeCats.length) return;
    [typeCats[currentIndex], typeCats[newIndex]] = [typeCats[newIndex], typeCats[currentIndex]];
    const incomeCats = type === "income" ? typeCats : categories.filter(c => c.type === "income");
    const expenseCats = type === "expense" ? typeCats : categories.filter(c => c.type === "expense");
    const newCategories = [...incomeCats, ...expenseCats];
    if (!selectedMonth) return;
    await budgetDb.saveAllCategories(sdk, selectedMonth, newCategories);
    categories = newCategories;
    await calculateActuals();
    cursorIndex = cursorIndex + (direction === "up" ? -1 : 1);
  }

  function selectTag(tag: string) {
    const parts = editorForm.tags.split(",").map(t => t.trim());
    parts[parts.length - 1] = tag;
    editorForm.tags = parts.join(", ") + ", ";
    tagAutocompleteIndex = -1;
  }

  function handleTagInputKeyDown(e: KeyboardEvent) {
    if (tagSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        tagAutocompleteIndex = Math.min(tagAutocompleteIndex + 1, tagSuggestions.length - 1);
        return;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        tagAutocompleteIndex = Math.max(tagAutocompleteIndex - 1, -1);
        return;
      } else if (e.key === "Enter" && tagAutocompleteIndex >= 0) {
        e.preventDefault();
        e.stopPropagation();
        selectTag(tagSuggestions[tagAutocompleteIndex]);
        return;
      } else if (e.key === "Tab" && tagSuggestions.length > 0) {
        e.preventDefault();
        selectTag(tagSuggestions[0]);
        return;
      }
    }
  }

  // Reset autocomplete when tags change
  $effect(() => {
    editorForm.tags;
    tagAutocompleteIndex = -1;
  });

  $effect(() => {
    if (selectedMonth && initialLoadComplete) {
      loadCategories().then(() => Promise.all([calculateActuals(), loadAllTrends()]));
    }
  });

  let unsubscribeRefresh: (() => void) | null = null;

  onMount(async () => {
    await loadAll();
    containerEl?.focus();
    unsubscribeRefresh = sdk.onDataRefresh(() => {
      loadAll();
    });
  });

  onDestroy(() => {
    unsubscribeRefresh?.();
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="budget-view" bind:this={containerEl} tabindex="0" onkeydown={handleKeyDown} role="application">
  <!-- Header -->
  <div class="header">
    <div class="title-row">
      <h1 class="title">Budget</h1>
      <div class="month-nav">
        <button class="nav-btn" onclick={() => cycleMonth(1)} disabled={availableMonths.indexOf(selectedMonth) === availableMonths.length - 1}>&#8592;</button>
        <span class="current-month">{formatMonth(selectedMonth)}</span>
        <button class="nav-btn" onclick={() => cycleMonth(-1)} disabled={availableMonths.indexOf(selectedMonth) === 0}>&#8594;</button>
        <button class="this-month-btn" onclick={goToCurrentMonth} title="Jump to current month" disabled={isCurrentMonth}>This Month</button>
        <button class="reset-btn" onclick={openResetModal} title="Reset or delete this month's budget" disabled={showCopyFromPrevious}>Reset</button>
      </div>
    </div>
  </div>

  {#if error}
    <div class="error-bar">{error}</div>
  {/if}

  <div class="main-content">
    <!-- Category list -->
    <div class="list-container">
      {#if isLoading}
        <div class="empty-state">Loading...</div>
      {:else if showCopyFromPrevious}
        <div class="copy-from-previous">
          <div class="copy-prompt">
            <p>No budget configured for <strong>{formatMonth(selectedMonth)}</strong></p>
            {#if monthsWithData.filter(m => m !== selectedMonth).length > 0}
              <p class="copy-hint">Copy categories from an existing month?</p>
            {:else}
              <p class="copy-hint">Start with default categories?</p>
            {/if}
          </div>
          <div class="copy-actions">
            {#if monthsWithData.filter(m => m !== selectedMonth).length > 0}
              <div class="copy-select-row">
                <select class="copy-month-select" bind:value={copySourceMonth}>
                  {#each monthsWithData.filter(m => m !== selectedMonth) as month}
                    <option value={month}>{formatMonth(month)}</option>
                  {/each}
                </select>
                <button class="btn primary" onclick={copyFromSourceMonth} disabled={!copySourceMonth}>Copy</button>
              </div>
            {/if}
            <button class="btn secondary" onclick={startFresh}>Start fresh</button>
          </div>
        </div>
      {:else if allActuals.length === 0}
        <div class="empty-state">
          <div class="empty-title">No budget categories</div>
          <div class="empty-message">Create categories to start tracking your spending.</div>
          <div class="empty-actions">
            <button class="btn primary" onclick={() => startAddCategory("expense")}>Add Category</button>
          </div>
          <div class="empty-hint">or press <kbd>a</kbd></div>
        </div>
      {:else}
        <!-- Remaining Hero Card -->
        <div class="remaining-hero" class:negative={remainingSummary.actual < 0}>
          <div class="remaining-hero-label">REMAINING</div>
          <div class="remaining-hero-amount">{formatCurrency(remainingSummary.actual)}</div>
          <div class="remaining-hero-detail">of {formatCurrency(remainingSummary.expected)} expected</div>
          <div class="pacing-indicator">
            <div class="pacing-bars">
              {#if monthPacing.isCurrentMonth}
                <div class="pacing-bar">
                  <div class="pacing-bar-label">Time</div>
                  <div class="pacing-bar-track">
                    <div class="pacing-bar-fill time" style="width: {monthPacing.monthElapsedPercent}%"></div>
                  </div>
                  <div class="pacing-bar-value">{monthPacing.monthElapsedPercent}%</div>
                </div>
              {/if}
              <div class="pacing-bar">
                <div class="pacing-bar-label">Spent</div>
                <div class="pacing-bar-track">
                  <div class="pacing-bar-fill spent" class:over={monthPacing.spentPercent > 100} class:ahead={monthPacing.pacingDiff < 0} class:behind={monthPacing.pacingDiff > 10} style="width: {Math.min(monthPacing.spentPercent, 100)}%"></div>
                </div>
                <div class="pacing-bar-value">{monthPacing.spentPercent}%</div>
              </div>
            </div>
            <div class="pacing-summary">
              {#if monthPacing.isCurrentMonth}
                {#if monthPacing.daysRemaining === 0}
                  Last day of the month
                {:else}
                  {monthPacing.daysRemaining} day{monthPacing.daysRemaining === 1 ? '' : 's'} left
                {/if}
              {:else if monthPacing.isPastMonth}
                Month complete
              {:else}
                Not started
              {/if}
            </div>
          </div>
        </div>

        <!-- Income Section -->
        <div class="section">
          <div class="section-header income-header">
            <div class="row-name section-title">INCOME</div>
            <div class="row-bar"></div>
            <div class="row-actual">{formatCurrency(incomeSummary.actual)}</div>
            <div class="row-expected">/ {formatCurrency(incomeSummary.expected)}</div>
            <div class="row-percent" style="color: {incomeSummary.percent >= 100 ? 'var(--accent-success, #22c55e)' : 'var(--text-muted)'}">{incomeSummary.percent}%</div>
            <div class="transfer-btn-placeholder"></div>
            <div class="row-details-placeholder"></div>
          </div>
          {#each incomeActuals as actual, i}
            {@const globalIndex = i}
            <div
              class="row"
              class:cursor={cursorIndex === globalIndex}
              data-index={globalIndex}
              onclick={() => handleRowClick(globalIndex)}
              ondblclick={() => handleRowDoubleClick(globalIndex)}
              onkeydown={(e) => e.key === 'Enter' && handleRowDoubleClick(globalIndex)}
              role="option"
              aria-selected={cursorIndex === globalIndex}
              tabindex={cursorIndex === globalIndex ? 0 : -1}
            >
              <div class="row-name">{actual.category}</div>
              <div class="row-bar">
                <div class="bar-bg"><div class="bar-fill" style="width: {Math.min(actual.percentUsed, 100)}%; background: {actual.percentUsed >= 100 ? 'var(--accent-success, #22c55e)' : 'var(--accent-primary)'}"></div></div>
              </div>
              <div class="row-actual">{formatCurrency(actual.actual)}</div>
              <div class="row-expected">/ {formatCurrency(actual.expected)}</div>
              <div class="row-percent" style="color: {actual.percentUsed >= 100 ? 'var(--accent-success, #22c55e)' : 'var(--text-muted)'}">{actual.percentUsed}%</div>
              <div class="transfer-btn-placeholder"></div>
              <!-- Inline RowMenu -->
              {#if menuOpenForId === actual.id}
                <button class="menu-backdrop" onclick={(e) => { e.stopPropagation(); closeMenu(); }} aria-label="Close menu"></button>
              {/if}
              <div class="row-menu">
                <button class="row-menu-btn" onclick={(e) => toggleMenu(actual.id, e)} aria-haspopup="true" aria-expanded={menuOpenForId === actual.id}>&#8942;</button>
                {#if menuOpenForId === actual.id}
                  <div class="row-menu-dropdown" role="menu">
                    <button class="menu-item" onclick={() => { loadTransactionsForCategory(actual); closeMenu(); }} role="menuitem">View</button>
                    <button class="menu-item" onclick={() => { const cat = categories.find(c => c.id === actual.id); if (cat) startEditCategory(cat); closeMenu(); }} role="menuitem">Edit</button>
                    <button class="menu-item danger" onclick={() => { const cat = categories.find(c => c.id === actual.id); if (cat) deleteCategory(cat); closeMenu(); }} role="menuitem">Delete</button>
                  </div>
                {/if}
              </div>
            </div>
          {/each}
          <button class="add-row" onclick={() => startAddCategory("income")}>+ Add income</button>
        </div>

        <div class="section-divider"></div>

        <!-- Budget Section -->
        <div class="section">
          <div class="section-header budget-header">
            <div class="row-name section-title">BUDGET</div>
            <div class="row-bar"></div>
            <div class="row-actual">{formatCurrency(budgetSummary.actual)}</div>
            <div class="row-expected">/ {formatCurrency(budgetSummary.expected)}</div>
            <div class="row-percent" style="color: {budgetSummary.percent > 100 ? 'var(--accent-danger, #ef4444)' : budgetSummary.percent > 90 ? 'var(--accent-warning, #f59e0b)' : 'var(--accent-success, #22c55e)'}">{budgetSummary.percent}%</div>
            <div class="transfer-btn-placeholder"></div>
            <div class="row-details-placeholder"></div>
          </div>
          {#each budgetActuals as actual, i}
            {@const globalIndex = incomeActuals.length + i}
            {@const incoming = incomingTransfers.filter(t => t.toCategory === actual.category)}
            {@const incomingRollover = roundToCents(incoming.reduce((sum, t) => sum + t.amount, 0))}
            {@const outgoing = outgoingTransfers.filter(t => t.fromCategory === actual.category)}
            {@const outgoingRollover = roundToCents(outgoing.reduce((sum, t) => sum + t.amount, 0))}
            {@const effectiveActual = roundToCents(actual.actual - incomingRollover)}
            {@const effectivePercent = actual.expected > 0 ? Math.round((effectiveActual / actual.expected) * 100) : 0}
            <div
              class="row"
              class:cursor={cursorIndex === globalIndex}
              data-index={globalIndex}
              onclick={() => handleRowClick(globalIndex)}
              ondblclick={() => handleRowDoubleClick(globalIndex)}
              onkeydown={(e) => e.key === 'Enter' && handleRowDoubleClick(globalIndex)}
              role="option"
              aria-selected={cursorIndex === globalIndex}
              tabindex={cursorIndex === globalIndex ? 0 : -1}
            >
              <div class="row-name">{actual.category}</div>
              <div class="row-bar">
                <div class="bar-bg"><div class="bar-fill" style="width: {Math.min(Math.max(effectivePercent, 0), 100)}%; background: {getStatusColor({...actual, percentUsed: effectivePercent})}"></div></div>
              </div>
              <div class="row-actual">{formatCurrency(effectiveActual)}</div>
              <div class="row-expected">/ {formatCurrency(actual.expected)}</div>
              <div class="row-percent" style="color: {getStatusColor({...actual, percentUsed: effectivePercent})}">{effectivePercent}%</div>
              <button
                class="transfer-btn"
                class:has-outgoing={outgoing.length > 0}
                onclick={(e) => openTransferModal(actual, e)}
                title={outgoing.length > 0 ? `${formatCurrency(outgoingRollover)} to ${formatMonth(getNextMonth(selectedMonth))}` : "Roll over to next month"}
              >&#8594;</button>
              <!-- Inline RowMenu -->
              {#if menuOpenForId === actual.id}
                <button class="menu-backdrop" onclick={(e) => { e.stopPropagation(); closeMenu(); }} aria-label="Close menu"></button>
              {/if}
              <div class="row-menu">
                <button class="row-menu-btn" onclick={(e) => toggleMenu(actual.id, e)} aria-haspopup="true" aria-expanded={menuOpenForId === actual.id}>&#8942;</button>
                {#if menuOpenForId === actual.id}
                  <div class="row-menu-dropdown" role="menu">
                    <button class="menu-item" onclick={() => { loadTransactionsForCategory(actual); closeMenu(); }} role="menuitem">View</button>
                    <button class="menu-item" onclick={() => { const cat = categories.find(c => c.id === actual.id); if (cat) startEditCategory(cat); closeMenu(); }} role="menuitem">Edit</button>
                    <button class="menu-item danger" onclick={() => { const cat = categories.find(c => c.id === actual.id); if (cat) deleteCategory(cat); closeMenu(); }} role="menuitem">Delete</button>
                  </div>
                {/if}
              </div>
            </div>
          {/each}
          <button class="add-row" onclick={() => startAddCategory("expense")}>+ Add category</button>
        </div>
      {/if}
    </div>

    <!-- Sidebar -->
    <div class="sidebar">
      {#if currentActual && currentCategory}
        <div class="sidebar-section">
          <div class="sidebar-title">Selected</div>
          <div class="detail-name">{currentActual.category}</div>
          <div class="detail-type">{currentActual.type}</div>
        </div>

        <div class="sidebar-section">
          <div class="sidebar-title">Tags</div>
          <div class="tag-list">
            {#each currentCategory.tags as tag}
              <span class="tag">{tag}</span>
            {/each}
          </div>
          {#if currentCategory.require_all}
            <div class="tag-mode">Requires ALL tags</div>
          {/if}
        </div>

        {@const effectiveActual = roundToCents(currentActual.actual - currentIncomingNet)}
        {@const remaining = roundToCents(currentActual.expected - effectiveActual)}
        <div class="sidebar-section">
          <div class="sidebar-title">Progress</div>
          <div class="detail-row">
            <span>Budget:</span>
            <span class="mono">{formatCurrency(currentActual.expected)}</span>
          </div>
          <div class="detail-row">
            <span>- Spent:</span>
            <span class="mono">{formatCurrency(currentActual.actual)}</span>
          </div>
          {#if currentIncomingNet !== 0}
            <div class="detail-row">
              <span>+ Rollover:</span>
              <span class="mono">{formatCurrency(currentIncomingNet)}</span>
            </div>
          {/if}
          <div class="detail-row detail-remaining">
            <span>= Remaining:</span>
            <span class="mono" class:positive={remaining >= 0} class:negative={remaining < 0}>{formatCurrency(remaining)}</span>
          </div>
        </div>

        {#if currentIncomingTransfers.length > 0 || currentOutgoingTransfers.length > 0}
          <div class="sidebar-section">
            <div class="sidebar-title">Rollovers</div>
            {#if currentIncomingTransfers.length > 0}
              <div class="transfer-group incoming">
                <div class="transfer-group-label">Incoming</div>
                {#each currentIncomingTransfers as transfer}
                  <div class="transfer-detail">
                    <span class="transfer-from">from {transfer.fromCategory}</span>
                    <span class="transfer-amount" class:positive={transfer.amount >= 0} class:negative={transfer.amount < 0}>
                      {transfer.amount >= 0 ? '+' : ''}{formatCurrency(transfer.amount)}
                    </span>
                  </div>
                {/each}
                {#if currentIncomingTransfers.length > 1}
                  <div class="transfer-total">
                    <span>Total:</span>
                    <span class="transfer-amount" class:positive={currentIncomingNet >= 0} class:negative={currentIncomingNet < 0}>
                      {currentIncomingNet >= 0 ? '+' : ''}{formatCurrency(currentIncomingNet)}
                    </span>
                  </div>
                {/if}
              </div>
            {/if}
            {#if currentOutgoingTransfers.length > 0}
              <div class="transfer-group outgoing">
                <div class="transfer-group-label">To {formatMonth(getNextMonth(selectedMonth))}</div>
                {#each currentOutgoingTransfers as transfer}
                  <div class="transfer-detail">
                    <span class="transfer-to">&#8594; {transfer.toCategory}</span>
                    <span class="transfer-amount" class:positive={transfer.amount >= 0} class:negative={transfer.amount < 0}>
                      {transfer.amount >= 0 ? '+' : ''}{formatCurrency(transfer.amount)}
                    </span>
                  </div>
                {/each}
                {#if currentOutgoingTransfers.length > 1}
                  <div class="transfer-total">
                    <span>Total:</span>
                    <span class="transfer-amount" class:positive={currentOutgoingNet >= 0} class:negative={currentOutgoingNet < 0}>
                      {currentOutgoingNet >= 0 ? '+' : ''}{formatCurrency(currentOutgoingNet)}
                    </span>
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/if}

        <div class="sidebar-section">
          <div class="sidebar-title">6-Month Trend</div>
          {#if categoryTrend.length === 0}
            <div class="trend-empty">No history</div>
          {:else}
            {@const maxActual = Math.max(...categoryTrend.map(t => t.actual), 1)}
            {@const avgActual = categoryTrend.reduce((sum, t) => sum + t.actual, 0) / categoryTrend.length}
            <div class="trend-chart">
              {#each categoryTrend as trend}
                <div class="trend-row">
                  <span class="trend-month">{formatMonthShort(trend.month)}</span>
                  <div class="trend-bar-container">
                    <div class="trend-bar" style="width: {(trend.actual / maxActual) * 100}%"></div>
                  </div>
                  <span class="trend-amount">{formatCurrency(trend.actual)}</span>
                </div>
              {/each}
            </div>
            <div class="trend-avg">Avg: {formatCurrency(avgActual)}</div>
          {/if}
        </div>
      {:else}
        <div class="sidebar-empty">Select a category</div>
      {/if}
    </div>
  </div>

  <!-- Keyboard shortcuts footer -->
  <div class="shortcuts-footer">
    <span class="shortcut"><kbd>j</kbd><kbd>k</kbd> nav</span>
    <span class="shortcut"><kbd>Enter</kbd> view</span>
    <span class="shortcut"><kbd>e</kbd> edit</span>
    <span class="shortcut"><kbd>a</kbd> add</span>
    <span class="shortcut"><kbd>d</kbd> delete</span>
    <span class="shortcut"><kbd>h</kbd><kbd>l</kbd> month</span>
    <span class="shortcut"><kbd>t</kbd> this month</span>
    <span class="shortcut"><kbd>{sdk.modKey}&#8593;</kbd><kbd>{sdk.modKey}&#8595;</kbd> reorder</span>
  </div>

  <!-- Transaction Drill-down Modal -->
  {#if showTransactions && drillDownCategory}
    <div class="modal-overlay" onclick={closeDrillDown} onkeydown={(e) => e.key === "Escape" && closeDrillDown()} role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal" style="width: 500px; max-height: 80vh" onclick={(e) => e.stopPropagation()} role="document">
        <div class="modal-header">
          <span class="modal-title">{drillDownCategory.category} - {formatMonth(selectedMonth)}</span>
          <button class="close-btn" onclick={closeDrillDown} aria-label="Close">&#215;</button>
        </div>
        <div class="modal-body">
          {#if drillDownLoading}
            <div class="modal-loading">Loading...</div>
          {:else if drillDownTransactions.length === 0}
            <div class="modal-empty">No transactions</div>
          {:else}
            <div class="txn-list">
              {#each drillDownTransactions as txn}
                <div class="txn-row">
                  <span class="txn-date">{txn.transaction_date}</span>
                  <span class="txn-desc">{txn.description}</span>
                  <span class="txn-amount" class:negative={txn.amount < 0}>{formatCurrency(txn.amount)}</span>
                </div>
              {/each}
            </div>
            <div class="modal-footer">
              <span>{drillDownTransactions.length} transactions</span>
              <span class="mono">Total: {formatCurrency(drillDownTransactions.reduce((s, t) => s + Math.abs(t.amount), 0))}</span>
            </div>
          {/if}
        </div>
        <div class="modal-actions">
          <button class="btn danger" onclick={handleModalDelete}>Delete</button>
          <button class="btn secondary" onclick={handleModalEdit}>Edit</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Edit Category Modal -->
  {#if isEditing}
    <div class="modal-overlay" onclick={cancelEdit} onkeydown={(e) => e.key === "Escape" && cancelEdit()} role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal" style="width: 500px; max-height: 80vh" onclick={(e) => e.stopPropagation()} role="document">
        <div class="modal-header">
          <span class="modal-title">{editingCategory ? 'Edit' : 'Add'} Category</span>
          <button class="close-btn" onclick={cancelEdit} aria-label="Close">&#215;</button>
        </div>
        <div class="modal-body">
          <div class="form">
            <label>Type<select bind:value={editorForm.type}><option value="income">Income</option><option value="expense">Expense</option></select></label>
            <label>Name<input type="text" bind:value={editorForm.category} placeholder="e.g., Groceries" /></label>
            <label>Expected<input type="number" bind:value={editorForm.expected} min="0" step="100" /></label>
            <label>Tags (comma-separated)
              <div class="tag-input-wrapper">
                <input type="text" bind:value={editorForm.tags} onkeydown={handleTagInputKeyDown} placeholder="e.g., groceries, food" autocomplete="off" />
                {#if tagSuggestions.length > 0}
                  <div class="tag-autocomplete-dropdown">
                    {#each tagSuggestions as tag, i}
                      <button type="button" class="autocomplete-item" class:selected={i === tagAutocompleteIndex} onclick={() => selectTag(tag)}>{tag}</button>
                    {/each}
                  </div>
                {/if}
              </div>
            </label>
            <label class="checkbox"><input type="checkbox" bind:checked={editorForm.require_all} /> Require ALL tags</label>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick={cancelEdit}>Cancel</button>
          <button class="btn primary" onclick={saveCategory}>Save</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Transfer Modal -->
  {#if showTransferModal}
    <div class="modal-overlay" onclick={closeTransferModal} onkeydown={(e) => e.key === "Escape" && closeTransferModal()} role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal" style="width: 450px; max-height: 80vh" onclick={(e) => e.stopPropagation()} role="document">
        <div class="modal-header">
          <span class="modal-title">Transfer: {formatMonth(transferStorageMonth)} &#8594; {formatMonth(getNextMonth(transferStorageMonth))}</span>
          <button class="close-btn" onclick={closeTransferModal} aria-label="Close">&#215;</button>
        </div>
        <div class="modal-body">
          <div class="transfer-modal-content">
            <div class="transfer-header">
              <span class="transfer-source">From: {transferSourceCategory}</span>
              {#if transferSourceVariance !== 0}
                <span class="transfer-variance" class:positive={transferSourceVariance >= 0} class:negative={transferSourceVariance < 0}>
                  {transferSourceVariance >= 0 ? 'Surplus' : 'Deficit'}: {formatCurrency(Math.abs(transferSourceVariance))}
                </span>
              {/if}
            </div>

            <div class="transfer-rows">
              {#each transferRows as row, i (row.id)}
                <div class="transfer-row">
                  <label class="transfer-to-label">
                    To
                    <select bind:value={row.toCategory}>
                      {#each availableTransferCategories as cat}
                        <option value={cat}>{cat}</option>
                      {/each}
                    </select>
                  </label>
                  <label class="transfer-amount-label">
                    Amount
                    <input type="number" bind:value={row.amount} step="1" />
                  </label>
                  {#if transferRows.length > 1}
                    <button class="transfer-row-delete" onclick={() => removeTransferRow(row.id)} title="Remove">&#215;</button>
                  {/if}
                </div>
              {/each}
            </div>

            <button class="add-transfer-btn" onclick={addTransferRow}>+ Add another transfer</button>

            {#if transferSourceVariance !== 0}
              <div class="transfer-summary">
                <div class="transfer-summary-row">
                  <span>Allocated:</span>
                  <span class="mono">{formatCurrencyCents(totalAllocated)} / {formatCurrencyCents(transferSourceVariance)}</span>
                </div>
                <div class="transfer-summary-row">
                  <span>Remaining:</span>
                  <span class="mono" class:positive={remainingToAllocate >= 0} class:negative={remainingToAllocate < 0}>
                    {formatCurrencyCents(remainingToAllocate)}
                  </span>
                </div>
              </div>
            {/if}
          </div>
        </div>
        <div class="modal-actions">
          {#if isEditingTransfers}
            <button class="btn danger" onclick={removeAllTransfers}>Remove All</button>
          {/if}
          <div style="flex: 1;"></div>
          <button class="btn secondary" onclick={closeTransferModal}>Cancel</button>
          <button class="btn primary" onclick={saveTransfers}>Save</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Reset Budget Modal -->
  {#if showResetModal}
    <div class="modal-overlay" onclick={closeResetModal} onkeydown={(e) => e.key === "Escape" && closeResetModal()} role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal" style="width: 400px; max-height: 80vh" onclick={(e) => e.stopPropagation()} role="document">
        <div class="modal-header">
          <span class="modal-title">Reset Budget - {formatMonth(selectedMonth)}</span>
          <button class="close-btn" onclick={closeResetModal} aria-label="Close">&#215;</button>
        </div>
        <div class="modal-body">
          <div class="reset-modal-content">
            {#if monthsWithData.filter(m => m !== selectedMonth).length > 0}
              <div class="reset-form-group">
                <span class="reset-label">Copy from another month</span>
                <div class="reset-row">
                  <select bind:value={resetSourceMonth} aria-label="Source month to copy from">
                    {#each monthsWithData.filter(m => m !== selectedMonth) as month}
                      <option value={month}>{formatMonth(month)}</option>
                    {/each}
                  </select>
                  <button class="reset-copy-btn" onclick={resetFromMonth} disabled={!resetSourceMonth}>Copy</button>
                </div>
              </div>

              <div class="reset-divider">
                <span>or</span>
              </div>
            {/if}

            <div class="reset-form-group">
              <span class="reset-label">Delete budget</span>
              <p class="reset-hint">Remove all categories and transfers for this month.</p>
              <button class="reset-delete-btn" onclick={deleteBudget}>Delete Budget</button>
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick={closeResetModal}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .budget-view {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
    outline: none;
  }

  .header {
    padding: var(--spacing-md) var(--spacing-lg);
    border-bottom: 1px solid var(--border-primary);
    background: var(--bg-secondary);
  }

  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-md);
  }

  .title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .month-nav {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
  }

  .nav-btn {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    color: var(--text-primary);
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  }

  .nav-btn:hover:not(:disabled) { background: var(--bg-primary); }
  .nav-btn:disabled { opacity: 0.3; cursor: default; }

  .this-month-btn, .reset-btn {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    color: var(--text-secondary);
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    margin-left: var(--spacing-sm);
    transition: all 0.15s ease;
  }

  .this-month-btn:hover:not(:disabled), .reset-btn:hover:not(:disabled) {
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .this-month-btn:disabled, .reset-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .current-month {
    font-family: var(--font-mono);
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    min-width: 80px;
    text-align: center;
  }

  .error-bar {
    padding: var(--spacing-sm) var(--spacing-lg);
    background: var(--accent-danger);
    color: white;
    font-size: 12px;
  }

  .main-content {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  .list-container {
    flex: 1;
    overflow-y: auto;
    font-family: var(--font-mono);
    font-size: 13px;
  }

  .empty-state {
    padding: var(--spacing-xl);
    text-align: center;
    color: var(--text-muted);
  }

  .empty-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: var(--spacing-md);
  }

  .empty-message {
    font-size: 13px;
    margin-bottom: var(--spacing-lg);
  }

  .empty-actions {
    display: flex;
    gap: var(--spacing-md);
    justify-content: center;
    margin-bottom: var(--spacing-md);
  }

  .empty-hint {
    font-size: 12px;
    color: var(--text-muted);
  }

  .empty-state kbd, .shortcuts-footer kbd {
    padding: 2px 6px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 3px;
    font-family: var(--font-mono);
  }

  .btn {
    padding: 8px 16px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    transition: opacity 0.15s;
  }

  .btn.primary {
    background: var(--accent-primary);
    color: white;
  }

  .btn.secondary {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border-primary);
  }

  .btn.danger {
    background: var(--accent-danger, #ef4444);
    color: white;
  }

  .btn:hover { opacity: 0.9; }

  .copy-from-previous {
    padding: var(--spacing-xl);
    text-align: center;
  }

  .copy-prompt p {
    margin: 0 0 var(--spacing-sm) 0;
    color: var(--text-primary);
  }

  .copy-prompt .copy-hint {
    color: var(--text-muted);
    font-size: 13px;
    margin-bottom: var(--spacing-lg);
  }

  .copy-actions {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-md);
    align-items: center;
  }

  .copy-select-row, .reset-row {
    display: flex;
    gap: var(--spacing-sm);
    align-items: center;
  }

  .copy-month-select, .reset-modal-content select {
    padding: 8px;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 13px;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%239ca3af' d='M2 4l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    padding-right: 28px;
    cursor: pointer;
  }

  .section-divider {
    height: 12px;
    background: var(--bg-primary);
    border-top: 1px solid var(--border-primary);
    border-bottom: 1px solid var(--border-primary);
  }

  .section-header {
    display: flex;
    align-items: center;
    padding: 8px var(--spacing-lg);
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-primary);
    gap: var(--spacing-md);
  }

  .section-header.income-header {
    border-left: 3px solid var(--accent-success, #22c55e);
    padding-left: calc(var(--spacing-lg) - 3px);
  }

  .section-header.income-header .section-title {
    color: var(--accent-success, #22c55e);
  }

  .section-header.budget-header {
    border-left: 3px solid var(--accent-primary, #3b82f6);
    padding-left: calc(var(--spacing-lg) - 3px);
  }

  .section-header.budget-header .section-title {
    color: var(--accent-primary, #3b82f6);
  }

  .section-title {
    font-weight: 700;
    color: var(--text-primary);
  }

  /* Remaining Hero Card */
  .remaining-hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--spacing-lg);
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-primary);
  }

  .remaining-hero-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .remaining-hero-amount {
    font-size: 32px;
    font-weight: 700;
    color: var(--accent-success, #22c55e);
    font-family: var(--font-mono, monospace);
  }

  .remaining-hero.negative .remaining-hero-amount {
    color: var(--accent-danger, #ef4444);
  }

  .remaining-hero-detail {
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Pacing Indicator */
  .pacing-indicator {
    margin-top: var(--spacing-md);
    width: 200px;
  }

  .pacing-bars {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .pacing-bar {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .pacing-bar-label {
    width: 36px;
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
  }

  .pacing-bar-track {
    flex: 1;
    height: 4px;
    background: var(--bg-tertiary);
    border-radius: 2px;
    overflow: hidden;
  }

  .pacing-bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.3s;
  }

  .pacing-bar-fill.time {
    background: var(--text-muted);
  }

  .pacing-bar-fill.spent {
    background: var(--accent-success, #22c55e);
  }

  .pacing-bar-fill.spent.behind {
    background: var(--accent-warning, #f59e0b);
  }

  .pacing-bar-fill.spent.over {
    background: var(--accent-danger, #ef4444);
  }

  .pacing-bar-value {
    width: 32px;
    font-size: 10px;
    color: var(--text-muted);
    text-align: right;
  }

  .pacing-summary {
    margin-top: 6px;
    font-size: 11px;
    color: var(--text-muted);
    text-align: center;
  }

  .add-row {
    display: block;
    width: 100%;
    padding: 6px var(--spacing-lg);
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border-primary);
    color: var(--text-muted);
    font-size: 12px;
    font-family: var(--font-mono);
    text-align: left;
    cursor: pointer;
  }

  .add-row:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .row {
    display: flex;
    align-items: center;
    padding: 8px var(--spacing-lg);
    border-bottom: 1px solid var(--border-primary);
    gap: var(--spacing-md);
    cursor: pointer;
  }

  .row:hover { background: var(--bg-secondary); }

  .row.cursor {
    background: var(--bg-tertiary);
    border-left: 3px solid var(--text-muted);
    padding-left: calc(var(--spacing-lg) - 3px);
  }

  .row-name {
    flex: 1;
    min-width: 100px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-bar {
    width: 80px;
    flex-shrink: 0;
  }

  .bar-bg {
    height: 4px;
    background: var(--bg-tertiary);
    border-radius: 2px;
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.2s;
  }

  .row-actual {
    width: 90px;
    flex-shrink: 0;
    text-align: right;
    color: var(--text-primary);
    font-weight: 600;
    white-space: nowrap;
  }

  .row-expected {
    width: 95px;
    flex-shrink: 0;
    text-align: right;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .row-percent {
    width: 50px;
    flex-shrink: 0;
    text-align: right;
    font-weight: 600;
    white-space: nowrap;
  }

  .row-details-placeholder, .transfer-btn-placeholder {
    width: 24px;
    flex-shrink: 0;
  }

  .transfer-btn-placeholder { margin-right: 4px; }

  .transfer-btn {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-muted);
    font-size: 14px;
    cursor: pointer;
    flex-shrink: 0;
    margin-right: 4px;
  }

  .transfer-btn:hover {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    color: white;
  }

  .transfer-btn.has-outgoing {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    color: white;
  }

  .sidebar {
    width: 200px;
    flex-shrink: 0;
    border-left: 1px solid var(--border-primary);
    background: var(--bg-secondary);
    padding: var(--spacing-md);
    overflow-y: auto;
  }

  .sidebar-section { margin-bottom: var(--spacing-lg); }

  .sidebar-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: var(--spacing-sm);
  }

  .sidebar-empty {
    color: var(--text-muted);
    font-size: 12px;
    font-style: italic;
  }

  .detail-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .detail-type {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: capitalize;
  }

  .tag-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .tag {
    padding: 2px 6px;
    background: var(--accent-primary);
    color: var(--bg-primary);
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
  }

  .tag-mode {
    font-size: 10px;
    color: var(--text-muted);
    margin-top: 4px;
    font-style: italic;
  }

  .detail-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 4px;
  }

  .detail-row.detail-remaining {
    font-weight: 600;
    color: var(--text-primary);
  }

  .mono { font-family: var(--font-mono); }
  .positive { color: var(--accent-success, #22c55e) !important; }
  .negative { color: var(--accent-danger, #ef4444) !important; }

  .trend-empty {
    color: var(--text-muted);
    font-size: 11px;
    font-style: italic;
  }

  .trend-chart {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .trend-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }

  .trend-month {
    width: 24px;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .trend-bar-container {
    flex: 1;
    height: 8px;
    background: var(--bg-tertiary);
    border-radius: 2px;
    overflow: hidden;
  }

  .trend-bar {
    height: 100%;
    background: var(--accent-primary);
    border-radius: 2px;
    transition: width 0.2s;
  }

  .trend-amount {
    width: 72px;
    text-align: right;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    flex-shrink: 0;
  }

  .trend-avg {
    margin-top: 6px;
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .transfer-group {
    margin-bottom: var(--spacing-md);
    padding: var(--spacing-sm);
    border-radius: 4px;
  }

  .transfer-group.incoming {
    background: rgba(59, 130, 246, 0.1);
    border-left: 2px solid var(--accent-primary);
  }

  .transfer-group.outgoing {
    background: rgba(107, 114, 128, 0.1);
    border-left: 2px solid var(--text-muted);
  }

  .transfer-group-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    margin-bottom: 4px;
  }

  .transfer-detail {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11px;
    padding: 2px 0;
  }

  .transfer-from, .transfer-to {
    color: var(--text-secondary);
  }

  .transfer-amount {
    font-family: var(--font-mono);
    font-weight: 600;
  }

  .transfer-total {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11px;
    padding-top: 4px;
    margin-top: 4px;
    border-top: 1px solid var(--border-primary);
    color: var(--text-secondary);
  }

  .shortcuts-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 8px var(--spacing-lg);
    gap: var(--spacing-lg);
    flex-wrap: wrap;
    border-top: 1px solid var(--border-primary);
    background: var(--bg-secondary);
  }

  .shortcut {
    font-size: 11px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .shortcut kbd {
    display: inline-block;
    padding: 2px 5px;
    font-size: 10px;
    color: var(--text-secondary);
    margin-right: 2px;
  }

  /* Modal styles */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .modal {
    background: var(--bg-secondary);
    border-radius: 8px;
    max-width: 90vw;
    display: flex;
    flex-direction: column;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--spacing-md) var(--spacing-lg);
    border-bottom: 1px solid var(--border-primary);
    flex-shrink: 0;
  }

  .modal-title {
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-btn {
    background: none;
    border: none;
    font-size: 20px;
    color: var(--text-muted);
    cursor: pointer;
    line-height: 1;
    padding: 0;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .close-btn:hover {
    color: var(--text-primary);
  }

  .modal-body {
    flex: 1;
    overflow-y: auto;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--spacing-sm);
    padding: var(--spacing-md) var(--spacing-lg);
    border-top: 1px solid var(--border-primary);
    flex-shrink: 0;
  }

  .modal-loading, .modal-empty {
    padding: var(--spacing-xl);
    text-align: center;
    color: var(--text-muted);
  }

  .txn-list {
    flex: 1;
    overflow-y: auto;
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .txn-row {
    display: flex;
    gap: var(--spacing-md);
    padding: 6px var(--spacing-lg);
    border-bottom: 1px solid var(--border-primary);
  }

  .txn-date {
    width: 80px;
    color: var(--text-muted);
  }

  .txn-desc {
    flex: 1;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .txn-amount {
    width: 70px;
    text-align: right;
    color: var(--text-primary);
  }

  .txn-amount.negative { color: var(--accent-danger, #ef4444); }

  .modal-footer {
    display: flex;
    justify-content: space-between;
    padding: var(--spacing-md) var(--spacing-lg);
    border-top: 1px solid var(--border-primary);
    font-size: 12px;
    color: var(--text-muted);
  }

  .form {
    padding: var(--spacing-lg);
    display: flex;
    flex-direction: column;
    gap: var(--spacing-md);
  }

  .form label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .form label.checkbox {
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }

  .form input, .form select {
    padding: 8px;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 13px;
  }

  .form input:focus, .form select:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .form select {
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%239ca3af' d='M2 4l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    padding-right: 28px;
    cursor: pointer;
  }

  /* Tag input autocomplete */
  .tag-input-wrapper {
    position: relative;
  }

  .tag-input-wrapper input {
    width: 100%;
    padding: 8px;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 13px;
  }

  .tag-input-wrapper input:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .tag-autocomplete-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-top: none;
    border-radius: 0 0 4px 4px;
    max-height: 200px;
    overflow-y: auto;
    z-index: 10;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }

  .autocomplete-item {
    display: block;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    text-align: left;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
  }

  .autocomplete-item:hover, .autocomplete-item.selected {
    background: var(--accent-primary);
    color: white;
  }

  /* RowMenu styles */
  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
    background: transparent;
    border: none;
    cursor: default;
  }

  .row-menu {
    position: relative;
    flex-shrink: 0;
  }

  .row-menu-btn {
    width: 24px;
    height: 24px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-muted);
    font-size: 14px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .row:hover .row-menu-btn,
  .row.cursor .row-menu-btn,
  .row-menu-btn[aria-expanded="true"] {
    opacity: 1;
  }

  .row-menu-btn:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border-color: var(--text-muted);
  }

  .row-menu-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 100;
    min-width: 120px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    overflow: hidden;
    margin-top: 2px;
  }

  .menu-item {
    display: block;
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s;
  }

  .menu-item:hover {
    background: var(--bg-tertiary);
  }

  .menu-item.danger {
    color: var(--accent-danger, #ef4444);
  }

  .menu-item.danger:hover {
    background: rgba(239, 68, 68, 0.1);
  }

  /* Transfer modal */
  .transfer-modal-content {
    padding: var(--spacing-md) var(--spacing-lg);
  }

  .transfer-header {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: var(--spacing-lg);
    padding-bottom: var(--spacing-md);
    border-bottom: 1px solid var(--border-primary);
  }

  .transfer-source {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .transfer-variance {
    font-size: 12px;
    font-family: var(--font-mono);
  }

  .transfer-rows {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-md);
    margin-bottom: var(--spacing-md);
  }

  .transfer-row {
    display: flex;
    gap: var(--spacing-sm);
    align-items: flex-end;
  }

  .transfer-to-label {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .transfer-to-label select {
    padding: 8px;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 13px;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%239ca3af' d='M2 4l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    padding-right: 28px;
    cursor: pointer;
  }

  .transfer-amount-label {
    width: 100px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .transfer-amount-label input {
    padding: 8px;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 13px;
    font-family: var(--font-mono);
  }

  .transfer-row-delete {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-muted);
    font-size: 18px;
    cursor: pointer;
  }

  .transfer-row-delete:hover {
    background: var(--accent-danger);
    border-color: var(--accent-danger);
    color: white;
  }

  .add-transfer-btn {
    width: 100%;
    padding: 8px;
    background: transparent;
    border: 1px dashed var(--border-primary);
    border-radius: 4px;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
    margin-bottom: var(--spacing-md);
  }

  .add-transfer-btn:hover {
    background: var(--bg-tertiary);
    border-color: var(--accent-primary);
    color: var(--text-primary);
  }

  .transfer-summary {
    padding: var(--spacing-sm) var(--spacing-md);
    background: var(--bg-tertiary);
    border-radius: 4px;
    font-size: 12px;
  }

  .transfer-summary-row {
    display: flex;
    justify-content: space-between;
    margin-bottom: 4px;
    color: var(--text-secondary);
  }

  .transfer-summary-row:last-child {
    margin-bottom: 0;
  }

  /* Reset modal */
  .reset-modal-content {
    padding: var(--spacing-lg);
  }

  .reset-form-group {
    margin-bottom: var(--spacing-md);
  }

  .reset-label {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: var(--spacing-sm);
  }

  .reset-hint {
    margin: 0 0 var(--spacing-sm) 0;
    font-size: 12px;
    color: var(--text-muted);
  }

  .reset-copy-btn {
    padding: 8px 16px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    background: var(--accent-primary);
    color: white;
  }

  .reset-copy-btn:hover:not(:disabled) { opacity: 0.9; }
  .reset-copy-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .reset-delete-btn {
    padding: 8px 16px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    background: var(--accent-danger);
    color: white;
  }

  .reset-delete-btn:hover { opacity: 0.9; }

  .reset-divider {
    display: flex;
    align-items: center;
    gap: var(--spacing-md);
    margin: var(--spacing-lg) 0;
    color: var(--text-muted);
    font-size: 12px;
  }

  .reset-divider::before,
  .reset-divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border-primary);
  }
</style>
