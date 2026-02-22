// src/utils/logger.ts

import chalk from "chalk";
import ora, { Ora } from "ora";

// ─── Core log levels ──────────────────────────────────────────────────────────

export function log(message: string): void {
  console.log(`${chalk.cyan("◆")} ${message}`);
}

export function info(message: string): void {
  console.log(`${chalk.gray("  │")} ${chalk.white(message)}`);
}

export function detail(message: string): void {
  console.log(`${chalk.gray("  │   ")}${chalk.gray(message)}`);
}

export function success(message: string): void {
  console.log(`${chalk.green("  ✔")} ${chalk.green(message)}`);
}

export function warn(message: string): void {
  console.warn(`${chalk.yellow("  ⚠")} ${chalk.yellow(message)}`);
}

export function error(message: string): void {
  console.error(`${chalk.red("  ✖")} ${chalk.red(message)}`);
}

export function debug(message: string): void {
  if (process.env["DEBUG"] === "true") {
    console.log(`${chalk.gray("  [debug]")} ${chalk.gray(message)}`);
  }
}

// ─── Banner ───────────────────────────────────────────────────────────────────

export function banner(version = "1.0.0"): void {
  const title = ` SmokeForge v${version} `;
  const bar = "─".repeat(title.length + 2);
  console.log();
  console.log(chalk.cyan(`  ┌${bar}┐`));
  console.log(chalk.cyan(`  │`) + chalk.bold.white(` ${title} `) + chalk.cyan(`│`));
  console.log(chalk.cyan(`  │`) + chalk.gray("  GenAI Smoke Test Generator  ") + chalk.cyan(`│`));
  console.log(chalk.cyan(`  └${bar}┘`));
  console.log();
}

// ─── Step header ─────────────────────────────────────────────────────────────

export function step(n: number, total: number, label: string): void {
  const num = chalk.bold.cyan(`[${n}/${total}]`);
  const lbl = chalk.bold.white(label);
  console.log(`\n${num} ${lbl}`);
}

// ─── Section divider ─────────────────────────────────────────────────────────

export function divider(): void {
  console.log(chalk.gray("  " + "─".repeat(60)));
}

// ─── Table-style key/value row (for summaries) ───────────────────────────────

export function row(label: string, value: string): void {
  const paddedLabel = label.padEnd(24);
  console.log(`  ${chalk.gray(paddedLabel)} ${chalk.white(value)}`);
}

// ─── Spinner ─────────────────────────────────────────────────────────────────

export function spinner(message: string): Ora {
  return ora({
    text: message,
    prefixText: "  ",
    color: "cyan",
  }).start();
}

