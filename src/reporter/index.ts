/**
 * Package entry point.
 *
 *   // playwright.config.ts
 *   reporter: [
 *     ['html'],                                         // built-in report, unchanged
 *     ['playwright-extended-report', { outputFolder: 'extended-report' }],
 *   ]
 *
 * The default export is the reporter; the named exports are a programmatic API
 * for adding tabs to an existing report (same as the CLI).
 */

import ExtendedHtmlReporter from './html';

export default ExtendedHtmlReporter;
export type { ExtendedReporterOptions, ReportSummary } from './html';
export { readTabs, writeTabs, upsertTab, removeTab } from '../tabs';
export type { ExtendedTab, ExtendedTabInput, ExtendedTabFormat, ExtendedTabIcon, ExtendedTabBadgeKind } from '../tabs';
export { showReport, startReportServer, startAiGateway } from '../server';
export type { AiOptions } from '../aiGateway';
export type * from '../shared/insightsFormat';
export type { ReportServer, ShowReportOptions } from '../server';
export type { FailureCluster, FailedTestInfo, FailureCategory } from './failureClusters';
